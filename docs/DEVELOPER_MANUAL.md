# SuppliWise Blockchain Features — Developer's Manual

> **Scope:** this manual covers the **blockchain / Web3 layer** (`server/blockchain/*`,
> `server/routes/web3/*`, `src/Components/Web3Panels/*`). For the rest of the application
> see `docs/DEVELOPER_GUIDE.md`; for the end-user guide see `docs/USER_MANUAL.md`; for the
> feature → code map see `BLOCKCHAIN_FEATURES.md`.

Technical reference for maintaining, extending and operating the Web3 layer.

---

## 1. What this layer is (and what it is not)

SuppliWise runs a **self-contained, simulated proof‑of‑work chain** inside the application:

- **MongoDB is the source of truth** for balances and business records.
- The **chain is a tamper‑evident audit anchor**, not a second source of truth.
- There is **no external chain, no gas, no wallets to fund, no RPC endpoint.**

The core contract, enforced in `server/blockchain/engine.js`:

> Mutate the database first, then anchor the change. An anchor failure is logged and **never**
> fails or rolls back the business operation.

Availability beats perfect atomicity; the DB stays authoritative, and every state change is
independently provable after the fact.

### Non‑negotiable privacy rule
Personal data is **never** written on‑chain. Anything that could contain personal data is
passed to `engine.anchor(type, actor, { secret })`, which stores only
`sha256(stableStringify(secret))` as the transaction's `dataHash`. Canonical JSON
(`stableStringify`, keys sorted recursively) guarantees the same payload always produces the
same hash.

---

## 2. Repository layout

```
server/
  index.js                     # Express app, rate limiters, /api/web3 mount, boot seed
  models/Web3.js               # All Web3 schemas + DEFAULT_PARAMS (DAO-governed economics)
  blockchain/
    crypto.js                  # stableStringify, sha256, ed25519 sign/verify, AES-GCM, CID
    rules.js                   # PURE decision logic: tallies, streaks, APY, escrow, disputes
    ledger.js                  # PoW block append/verify/lookup
    engine.js                  # The only state mutator (credit/debit/transfer/stake/rewards)
    seed.js                    # Idempotent bootstrap: system wallets, demo data, oracle feeds
  routes/web3/
    index.js                   # Public routes BEFORE protect; authenticated routers after
    chain.js supply.js rewards.js market.js govern.js data.js ecosystem.js
  Test File/web3.test.js       # 68 unit tests (node:test)
  test-web3-flows.js           # 81-check end-to-end HTTP smoke test
my-react-app/
  src/api/web3.js              # Thin API client (no state, no logic)
  src/Pages/Web3.css           # Shared styles, all classes prefixed w3-
  src/Components/Web3Panels/   # Presentational panels (default exports, no props)
  src/Pages/{Web3Hub,Marketplace,Governance,Verify,Share}Page.jsx
```

**Why `rules.js` is separate:** every "smart contract" decision (quorum, streak payout, APY,
fee split, dispute outcome) is a pure function with no I/O. That makes them exhaustively unit
testable — which is exactly what `Test File/web3.test.js` does.

---

## 3. Running it

```bash
# API (port 5000)
cd server && npm install && node index.js

# Frontend (Vite, port 5173)
cd my-react-app && npm install && npm run dev
```

### Required environment (`server/.env`)

| Variable | Purpose |
| --- | --- |
| `MONGO_URI` | Mongo connection string. **Boot fails fast if missing.** |
| `JWT_SECRET` | Session signing **and** the AES‑256‑GCM key for wallet key envelopes. Boot fails if it is the placeholder. |
| `PORT` | Optional, default `5000`. |
| `CHAIN_DIFFICULTY` | Optional, default `3`. |
| `TRUST_PROXY` | `true` only behind a proxy you control. |
| `ALLOW_DEV_OTP_RESPONSE` | Must **never** be `true` in production. |
| `ADMIN_ALIAS`, `ADMIN_PASSWORD_HASH`, `ADMIN_TOTP_SECRET` / `ADMIN_ACCOUNTS` | Admin accounts ensured at boot. |

> The wallet key envelope is encrypted with a key derived from `JWT_SECRET`. Rotating
> `JWT_SECRET` makes existing `privateKeyEnc` values undecryptable. Plan a re‑encryption
> migration before rotating it in production.

### Boot sequence
`Connected to MongoDB` → admin accounts ensured → `Server running on port 5000` → then two
**non‑blocking** tasks: `[web3] chain ready at height N (difficulty 3)` and the SMTP check. A
seed or SMTP failure is logged and never prevents the API from serving.

---

## 4. Chain internals

### Data model
```js
Block { index (unique), timestamp, prevHash, nonce, hash, txs: [Tx] }
Tx    { txHash, type, actor, data /* public metadata only */, dataHash /* always present */, timestamp }
```

- `normalizeTx()` hashes a transaction's fields + its `dataHash` → `txHash`.
- `headerHash()` hashes the block header (index, timestamp, prevHash, nonce, canonical txs) → `hash`.
- `append()` mines a nonce until `hash` has `difficulty` leading zero hex characters, then
  inserts the block with `prevHash` = previous block's hash.
- `verify()` walks the whole chain, recomputing every hash **and** every link, and reports
  `{ valid, checked, height, difficulty, brokenAt? }`. `GET /api/web3/chain/verify` exposes
  this, and the smoke test asserts `valid === true`.

Raising difficulty slows every anchor; the smoke suite issues ~90 anchors per run, so keep it
at 3 (or lower) for local work.

### Transaction types (anchors)
`reward:<kind>`, `stake`, `unstake`, `stake_reward`, `escrow:deposit|release|fee|refund`,
`market:list`, `consult:book|refund`, `loyalty:burn`, `dispute:open`, `dao:propose|vote|execute`,
`knowledge:post`, `consent:grant|revoke`, `trial:consent|withdraw`, `supply:create|step`,
`cert:anchor`, `nft:mint`, `rec:anchor`, `health:anchor`, `storage:pin`, `oracle:update`.

---

## 5. State engine (`server/blockchain/engine.js`)

**All mutations go through this module.** Routes never touch `Wallet` balances directly.

| Function | Contract |
| --- | --- |
| `getConfig()` / `setParam()` | DAO‑governed params, cached 30 s, backfilled from `DEFAULT_PARAMS` when new keys are added. |
| `ensureWalletForUser()` | Creates wallet + DID + key, grants the welcome bonus **through `grantReward`** so history is complete. Safe under concurrent first‑hit (unique index race resolved). |
| `credit()` / `debit()` | Single‑sided balance change + anchor. `debit` is conditional on sufficient funds. |
| `transfer()` | Atomic two‑sided; a failed credit **rolls the debit back** before rethrowing. |
| `stake()` / `unstake()` | Move balance ⇄ staked, accruing pending yield first. |
| `accrueStake()` | Pro‑rated APY on activity, guarded by a conditional update on the exact last‑accrual timestamp (double claim impossible). |
| `grantReward()` | The only reward path: create `RewardEvent` (unique `(user, kind, refId)`) → `credit()` → **backfill `txHash`** on the history row. Returns `{ alreadyClaimed, amount, txHash, blockIndex }`. |
| `anchor()` | Never throws. Returns `{ index: -1, hash: '', txs: [''] }` on failure. |

Operational errors use `EngineError` with a `code` (`INSUFFICIENT`, `NO_WALLET`,
`BAD_AMOUNT`, `BAD_PARAM`, `SAME_WALLET`, `NO_KEY`); routes map any `error.code` to **400**
and everything else to **500**.

### Governance parameters
`DEFAULT_PARAMS` in `server/models/Web3.js` is the contract's ABI — the frontend's "updatable"
list, the proposal validator and the engine all read from it. Adding a parameter requires
only a new default; existing config rows are backfilled automatically.

---

## 6. HTTP API

Base: `/api/web3`. All routes are JSON, rate limited (`userLimiter`, 600/min local) and
return meaningful `400`s with a `message`.

### Public (no session — safe to link/QR)
| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/verify/:code` | Full journey + recomputed chain proofs. `400` malformed code, `404` unknown. |
| `GET` | `/verify/:code/qr?base=https://…` | QR data URL. `base` must match `^https?://`. |
| `GET` | `/share/:token` | Doctor view of a shared profile. 32‑hex token; `404` when expired/revoked. |

### Wallet, chain, config
`GET /wallet` · `GET /wallet/private-key` (PEM) · `GET /chain?limit&before` · `GET /chain/verify` · `GET /tx/:hash` · `GET /config`

### Supply
`GET|POST /supply/batches` · `POST /supply/batches/:id/events` · `POST /supply/batches/:id/certifications`

### Rewards, staking, loyalty
`GET /rewards/status` · `POST /rewards/checkin` · `POST /rewards/intake` · `POST /rewards/assessment` · `GET /rewards/events` · `GET /rewards/nfts` · `POST /rewards/achievements/check` · `POST /stake` · `POST /unstake` · `GET /loyalty` · `POST /loyalty/redeem`

### Marketplace
`GET|POST /market/listings` · `GET|POST /market/orders` · `POST /market/orders/:id/confirm` · `POST /market/orders/:id/dispute` · `GET /market/disputes` · `POST /market/disputes/:id/vote`

### Governance
`GET /dao/config` · `GET|POST /dao/proposals` · `POST /dao/proposals/:id/vote` · `GET|POST /knowledge` · `POST /knowledge/:id/upvote`

### Data, privacy, proofs
`GET /health/ledger` · `POST /health/ledger/anchor` · `GET /health/export` · `POST /health/backup` · `POST|GET /storage/pin`, `GET /storage/:cid` · `GET|POST /data/shares`, `DELETE /data/shares/:id` · `POST /recommendations/anchor`, `GET /recommendations/anchor/:assessmentId` · `GET|POST /profile-shares`, `DELETE /profile-shares/:id`

### Ecosystem
`GET /trials` · `POST /trials/:id/optin` · `POST /trials/:id/withdraw` · `GET /oracle/feeds` · `POST /oracle/refresh` · `GET /experts` · `POST /experts/:id/book` · `GET /bookings` · `POST /bookings/:id/cancel`

### Auth model
`routes/web3/index.js` registers the three public endpoints **before** `protect`, then mounts
each router behind a `userOnly` guard that returns `403` for `role === 'admin'`. If you add a
router, mount it inside that group so the guard applies.

---

## 7. Frontend integration

- `src/api/web3.js` is a **thin client**: one exported function per endpoint, no state, no
  business rules. Add a function there before touching a panel.
- Panels in `src/Components/Web3Panels/` are **default exports with no props** — they read
  the API and own their local state. Keep them presentational; logic belongs on the server.
- All styling is `Web3.css` with a `w3-` prefix. Don't introduce unprefixed classes.
- Mount‑time fetches use the established lint convention:
  ```jsx
  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);
  ```
- Pages: `/web3` (hub), `/marketplace`, `/governance` — all `ProtectedRoute`. `/verify`,
  `/verify/:code`, `/share/:token` are **intentionally public**; never wrap them in
  `ProtectedRoute`.

---

## 8. Testing

```bash
cd server        && npm test                    # 68 unit tests (crypto, rules, ledger)
cd server        && node test-web3-flows.js     # 81-check E2E over real HTTP
cd my-react-app  && npm test                    # 9 feature-registry parity tests
cd my-react-app  && npm run lint                # must stay at 0 errors
cd my-react-app  && npm run build               # must succeed
```

### The smoke test
`test-web3-flows.js` registers three throwaway accounts
(`web3-smoke-{a,b,c}-<ts>@example.com` — buyer, seller, juror), then walks all 20 features
through the real HTTP surface. It is **re‑run safe**: it purges prior `web3-smoke-*` users,
their Web3 documents, **and orphaned wallets** (non‑system wallets whose user no longer
exists) so the juror pool stays deterministic.

> ⚠️ **Never run two smoke tests concurrently** (or alongside another suite that purges
> `web3-smoke-*`). The second run's cleanup deletes the first run's users mid‑flight and the
> victim fails with confusing `400`s (recreated wallet, blocked welcome credit). If a run
> fails oddly, check for a concurrent run before hunting a code bug.

It also asserts the pre‑run invariant "**no staked non‑system wallets**" — real accounts may
legitimately hold an unstaked wallet, so that is not a failure.

### Adding a feature — the checklist
1. **Model** (if needed) in `server/models/Web3.js`. Never store personal data that will be
   anchored; anchor a digest.
2. **Pure rules** in `blockchain/rules.js` + unit tests in `Test File/web3.test.js`.
3. **Route** in the matching `routes/web3/*.js`: validate lengths explicitly (truncate with
   `.slice()` or reject with `400` — never let a schema `maxlength` surface as a `500`),
   mutate through `engine`, then `engine.anchor(...)`, and map `error.code` → `400`.
4. **Idempotency** for any payout: a unique index plus `engine.grantReward`.
5. **API client** function in `src/api/web3.js`, then a panel and a `w3-` styled section.
6. **Smoke checks** for the happy path, the replay/idempotency path, and one authorization
   path (party cannot vote, admin rejected, own content cannot be upvoted).
7. Run the full matrix above.

---

## 9. Security model

| Concern | Control |
| --- | --- |
| Key custody | ed25519 private key sealed with AES‑256‑GCM (`iv`/`ct`/`tag` sub‑document) keyed from `JWT_SECRET`; export is owner‑only and returns PEM. |
| PII on‑chain | Never. Only `sha256` digests and counts. Share datasets are coarse bands built server‑side. |
| Replay / double spend | Unique `(user, kind, refId)` reward index; conditional balance updates; stake accrual CAS; escrow settlement guarded by a status transition to `released`/`refunded`. |
| Privilege | Admin accounts rejected by every Web3 router. Dispute parties cannot vote and are excluded from the jury. Users cannot upvote themselves. Loyalty codes are single use. |
| Abuse | Per‑bucket rate limits; Web3 uses a non‑escalating bucket so normal traffic can never trigger the brute‑force lockout ladder. |
| Resilience | `unhandledRejection` / `uncaughtException` handlers are **log‑only** (a bad request must never take the API down). Fix the route, not the guard. |
| Input | Validate types/lengths at the route; ids must pass `mongoose.isValidObjectId`. |

---

## 10. Operational notes & troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE :::5000` | Another API instance is running. The crash guard logs and keeps the process alive *without* a listener — kill the stale process, then start one. Verify with `Get-NetTCPConnection -LocalPort 5000 -State Listen`. |
| `privateKeyEnc: Cast to string failed` | The envelope must be an object column (`{iv, ct, tag}`), never a `String`. If you see this, the schema was edited back. |
| `E11000 … tokenId_1` on achievements | Lost a mint race. The route now treats it as "already owned" and recomputes a serial; if you mint elsewhere, do the same. |
| `Insufficient WELL balance` unexpectedly | A concurrent purge deleted the wallet mid‑request (see the smoke warning), or the DAO genuinely spent it. Check `GET /wallet` and the reward/transfer history. |
| Juror pool looks wrong | Orphaned wallets from deleted accounts. The smoke cleanup purges them; in production, clean up with the same rule (`isSystem != true` and no live user). |
| Chain height not growing | Anchors are best‑effort; a persistent failure is logged as `[web3 anchor] …`. Check Mongo connectivity and `CHAIN_DIFFICULTY`. |
| Page renders but a fetch says "aborted" | Usually the tab was navigated away mid‑request (logout/redirect), not an app bug. Reproduce in a fresh tab before investigating. |
| Frontend lint error after a page edit | A duplicate top‑level declaration is the usual cause — `Parsing error: Identifier 'X' has already been declared`. Remove the stale copy. |

### Adding a DAO parameter
Add it to `DEFAULT_PARAMS`; existing config rows are backfilled on read; it immediately
appears in `GET /dao/config` → `updatable` and becomes proposable. No migration needed.

---

## 11. Reference: verification status

| Check | Command | Status |
| --- | --- | --- |
| Server unit tests | `cd server && npm test` | 68 passed, 0 failed |
| Frontend tests | `cd my-react-app && npm test` | 9 passed, 0 failed |
| E2E smoke (20 features) | `cd server && node test-web3-flows.js` | 81 passed, 0 failed |
| Lint | `cd my-react-app && npm run lint` | 0 errors (4 pre‑existing warnings) |
| Build | `cd my-react-app && npm run build` | success |

See `BLOCKCHAIN_FEATURES.md` for the feature → code map and `docs/USER_MANUAL.md` for the
end‑user guide.
