# SuppliWise — Capstone Critique Analysis

> **Purpose:** A defensible, categorized inventory of the system's weak, overstated, or
> questionable areas. Every finding below was verified by reading the code, not the docs.
>
> **How to use this:** Don't present this as an apology. Present it as *"we found these, here
> is what we fixed, here is what is deliberately left as a named limitation."* A capstone panel
> rewards a team that knows exactly where its own system is weak far more than a team that
> claims it has no weaknesses — because the second claim is never true, and they know it.
>
> **Scoring key:** 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low / Info

---

## Executive summary — the ten findings that decide your defense

| # | Sev | Finding | Location |
|---|-----|---------|----------|
| 1 | 🔴 | **Not a blockchain.** One process, one MongoDB, a mutex. No consensus, no replication, no second node. | `server/blockchain/ledger.js:89-221` |
| 2 | 🔴 | **15 of 20 hardcoded PMIDs point to unrelated papers.** Verified against NCBI. Shown to users with a ✅. | `server/routes/recommend.js:1122-1189` |
| 3 | 🔴 | **Live user credentials committed to a public repo**, and never rotated. Admitted in 3 places. | `server/scripts/restore-lost-account.js:44-52` |
| 4 | 🔴 | **No crisis/suicide detection in the AI chat.** It exists for the form only. | `server/routes/chat.js` |
| 5 | 🔴 | **Cross-user health data leak.** Personalised AI response dedupe-keyed on supplement name only. | `server/routes/supplement_detail.js:132` |
| 6 | 🔴 | **One fresh account can pass any DAO proposal** and set APY to 10⁹%. | `routes/web3/govern.js:139-197` |
| 7 | 🔴 | **The chain never covers transaction payloads.** `txs[].data` is freely editable; `/chain/verify` still says `valid: true`. | `server/blockchain/ledger.js:21-24` |
| 8 | 🟠 | **`npm start` never sets `NODE_ENV=production`** → every production guard silently disabled. | `server/package.json:10` |
| 9 | 🟠 | **Zero CI, zero coverage tooling, zero containerization.** Self-reported as finding I3. | repo-wide |
| 10 | 🟠 | **No payment integration.** Checkout is a base64 screenshot verified by hand. | `server/utils/paymentInstructions.js` |

---

## Category 1 — Blockchain / Web3: the credibility gap

This is your highest-risk category. The cryptography is real; the *claims* are not supported.

### 🔴 1.1 There is no consensus, no replication, no second node

`server/blockchain/ledger.js` is a class in a single Node process. Appends serialise through an
in-process promise queue (a mutex, `:89-109`). Blocks are Mongoose documents
(`server/models/Web3.js:29-39`). "Consensus" is `hash.startsWith('000')` on the local machine
(`ledger.js:26-28, 61-67`) — difficulty 3 ≈ 4,096 hashes, sub-millisecond, with **no difficulty
adjustment, no block reward, no coinbase, no miner competition**.

Repo-wide: zero hits for `ipfs`, `libp2p`, `ethers`, `viem`, `bitcoinjs`, or any RPC/node concept.

> **Panel question you cannot answer:** *"Restore a 6-hour-old MongoDB snapshot while the server
> runs — do the two chains diverge, and which one wins? What is your fork-selection rule?"*

### 🔴 1.2 The database is authoritative; the chain is explicitly best-effort

Your own code comment, `server/blockchain/engine.js:18-26`:

> *"mutate the database FIRST (it is the source of truth) … An anchor failure is logged, never
> able to roll back or fail the business operation — availability over perfect atomicity"*

`anchor()` (`engine.js:99-107`) swallows every error and returns `{ index: -1, hash: '' }`. A token
can be minted with `blockIndex: -1` and the operation still reports success. The UI still says
"anchored on-chain" (`GovernancePage.jsx:445`, `MarketplacePage.jsx:530-531`).

### 🔴 1.3 Block hashes do not cover transaction payloads

```js
// ledger.js:21-24
const txPart = (txs || []).map((t) => t.txHash).join('|');   // ← only the hash strings
return sha256Hex(stableStringify({ index, timestamp, prevHash, nonce, txPart }));
```

`VERIFY_PROJECTION` (`ledger.js:46`) explicitly projects out `txs.data` — the comment at `:41-45`
admits it is "never hashed into the header". So `db.swBlock.updateOne({}, {$set: {'txs.0.data.amount': 999999}})`
leaves **every hash valid**, and `/api/web3/chain/verify` returns `valid: true`.

The human-readable payload of every transaction — amount, order id, reason, parameter change — is
**unauthenticated**.

**Fix is three lines.** This is the highest-credibility-per-effort change in the entire project.

### 🔴 1.4 History can be truncated at the tip, and the trust anchor is in the audited DB

Deleting the newest N blocks leaves a shorter chain that still walks clean and still reports
`valid: true`. There is no external anchor of the head hash. The `ChainAudit` checkpoint that
makes verification cheap is **a document in the same MongoDB, writable with the same credentials**
(`ledger.js:174-195`).

### 🔴 1.5 One brand-new account can pass any proposal — including infinite APY

```
welcomeBonus:    100   // models/Web3.js:110 — every new account
daoQuorumWeight:  50   // models/Web3.js:126 — the quorum to beat
```
```js
// govern.js:188 — proposer auto-votes 'for' with their FULL weight
const weight = round2(wallet.balance + wallet.staked);
```

A fresh account gets 100 WELL, opens a proposal, self-votes 100, quorum 50 is met, opposition is
zero → **passes**. No deposit, no minimum turnout, no timelock, no vote-escrow.

Two-step capture: pass `daoQuorumWeight = 0`, then every later proposal passes on one self-vote.
`assertParamValue` (`engine.js:72-78`) bounds every numeric param to `[0, 1e9]` — a NaN guard, not
an economics guard. Set `stakeApyPct = 1e9` and `accrueStake` mints ~10⁷× per day.

### 🔴 1.6 The dispute jury can be one person, isn't random, and its weight is discarded

```js
// market.js:148-158 — "Randomly selected jurors" per the comment on :143
Wallet.find({ staked: {$gt: 0} }).select('address').limit(5).lean();   // no sort
```
Natural Mongo order = insertion order = front-runnable. Then:
```js
// rules.js:178-179
const panelSize = openJury ? MIN_OPEN_JURY : Math.max(1, jurors.length);
```
**One staked wallet ⇒ one vote settles every dispute.** Your own unit test asserts it:
`Test File/web3.test.js:351-355` — *"A single appointed juror still decides alone."*

And weight is recorded, displayed as `w {weight}` badges, and **never read** by `disputeOutcome`
(`rules.js:157-163` counts votes, ignores `v.weight`).

### 🔴 1.7 No custody, server signs on the user's behalf, key export has no step-up

Key generated server-side (`engine.js:136`), sealed with `sha256(JWT_SECRET)` — a bare hash, no
HKDF, no salt, one key for every wallet on the instance. The server **decrypts it and signs**:
```js
// data.js:171-172
const privateKey = engine.decryptPrivateKey(wallet);
const signature = sign(privateKey, stableStringify(payload));
```
`GET /api/web3/wallet/private-key` (`chain.js:48-76`) returns the raw PKCS#8 PEM to any
authenticated owner with **no password re-entry, no 2FA, no step-up** — despite
`server/middleware/stepUp.js` existing in the repo.

Meanwhile the UI says *"Self-custodied wallet & decentralized ID"* (`Web3PlanGate.jsx:32`) and
*"never leaves the server unencrypted except right now, for you"* (`WalletPanel.jsx:103-105`).
It can decrypt it **at any time**, not only "right now."

### 🔴 1.8 Unbounded faucet, no supply model

Repo-wide grep for `totalSupply`, `MAX_SUPPLY`, `circulating`: **nothing**. Faucets:
welcome 100/user · knowledge post **10, unbounded** · data share **25, unbounded** · assessment
**15, unbounded** · upvote loop **2+1, unbounded**.

`RewardEvent`'s unique `(user, kind, refId)` prevents *replay*. It provides **zero** protection
against *volume* — a new `refId` is a new payout.

"Burn" is a transfer to `sw_system_treasury` labelled `loyalty:burn` (`rewards.js:377-383`).
Nothing is destroyed.

### 🟠 1.9 The "content address" is not content-addressed, and the comment is wrong

```js
// crypto.js:123-124 — "the same content always maps to the same CID"
```
But `encrypt()` generates a **fresh random IV per call** (`crypto.js:107`) and `contentId` hashes
only the ciphertext. **Pinning identical plaintext twice yields two different CIDs.** The claimed
property is false. `models/Web3.js:396-401` half-concedes it — and the concession is also wrong.

### 🟠 1.10 Fabricated third-party safety evidence, served publicly

`server/blockchain/seed.js` asserts, as on-chain records: **Eurofins Labs**, **USP Potency & Purity
Assay**, **Non-GMO Project Verified**, **Informed Sport Certified**, **USDA Organic**, **IFOS
5-star**. Invented. Served from the **public, unauthenticated** endpoint with `verified: true` and
`network: 'SuppliWise Mainnet (proof-of-work)'` (`supply.js:70-106`).

Demo batch codes are deterministic and offline-precomputable: `SW-${sha256('batch:'+i).slice(0,8)}`
(`seed.js:269`).

**In a supplement-safety product this is the finding most likely to lose a panel's trust, because
it looks like fraud rather than a design shortcut.**

### 🟠 1.11 Supply-chain provenance is a private self-authored notebook

Every read/write is scoped `ownerFilter(req) = { createdBy: req.user._id }` (`supply.js:35-37`).
**One account creates the batch and writes every step and every certificate.** No brand role, no
manufacturer counter-signature, no regulator.

On-chain payload per step is only `{code, step, at, prev}` (`supply.js:240-242`) — but
`VerifyPage.jsx:141-142` tells the scanner *"Every step below is anchored to block … each hash was
recomputed just now."* Location, note, and actor name are **not on the chain at all**.

### 🟠 1.12 "Verifiable AI recommendations" — logic version is a constant

```js
const RECOMMENDER_LOGIC_VERSION = 'suppliwise-rec-engine@1';   // data.js:29
```
The actual recommender is an LLM with runtime-selectable provider and model. **The anchor records
neither provider, model, prompt, nor parameters.** Swap the model overnight; the anchor is
byte-identical. And the anchor is freely rewritable:
```js
RecAnchor.findOneAndUpdate({user, assessmentId}, {$set: {...}}, {upsert: true});  // data.js:398
```
**Edit the assessment, click Anchor again, and "Fully verified ✓" renders.**

### 🟡 1.13 No gas, no metering — and the "consensus" is itself the DoS surface

Every Web3 write runs a synchronous PoW search on the event loop (`ledger.js:61-67`,
`MAX_NONCE = 1<<26` ⇒ up to 67M SHA-256 calls in one blocking loop). At `CHAIN_DIFFICULTY=5` that is
~1M iterations — seconds of hard CPU block, on a request thread.

Your own comment (`govern.js:26-31`) documents that this **was already exploited**: *"a single
request became attacker-controlled mining work."* The mitigation is a 15-second latch, not metering.

### 🟡 1.14 Verification is cached, deferred, and fails open

`ledger.js:348-363` — if the deep audit hasn't finished in 5s, `verify()` returns
**`valid: true` with `pending: true`**, and the admin panel prints *"Hash-linkage + nonce re-audit
passed."*

### ⚪ 1.15 UI language is consistently one degree more certain than the code

| Claim | Location | Reality |
|---|---|---|
| "impossible to rewrite after the fact" | `ExplorerPanel.jsx:78` | payloads unhashed; truncation undetectable |
| "Self-custodied wallet" | `Web3PlanGate.jsx:32` | server holds keys and signs with them |
| "Verified Marketplace" | `MarketplacePage.jsx:275` | no seller verification, no KYC, no reputation |
| "stake-weighted juror vote" | `MarketplacePage.jsx:32-33` | weight discarded |
| "Trusted real-world data — signed daily" | `EcosystemPanel.jsx:70-71` | `sha256(date+key)` pseudo-random walk |
| "verify it at /web3/health/verify" | `LedgerPanel.jsx:61` | **that endpoint does not exist** |
| "SuppliWise Mainnet (proof-of-work)" | `supply.js:104` | one process, one DB |

> **Highest-value 5-minute fix in the project:** re-label everything. "Mainnet" → "local
> append-only audit ledger". "Self-custodied wallet" → "server-held wallet with exportable key".
> "Verified Marketplace" → "P2P Marketplace". "Decentralized jury" → "staked-holder panel".
> That converts ten liabilities into honest scoping.

### ✅ What to defend (this part is genuinely good)

Real `sha256` (`crypto.createHash`), canonical JSON (`stableStringify`, key-sorted), **real
ed25519** with correct SPKI re-assembly, real AES-256-GCM. **No hand-rolled crypto. No `Math.random`
in any hash.** `glitch-hunt-web3.js` is an honest 21-section adversarial suite that documents what
used to be broken (escrow double-confirm, stock reservation race, double-cancel double-refund).

**Reframe the whole module honestly as: "a tamper-evident audit log with real cryptographic
primitives."** That is a defensible, respectable capstone claim. "Blockchain" is not.

---

## Category 2 — AI & Recommendation Safety

The highest-severity category, because the domain is health.

### 🔴 2.1 Fabricated citations — 15 of 20 PMIDs point to unrelated papers

`server/routes/recommend.js:1122-1189` (`inferEvidence`). Verified against NCBI E-utilities:

| Claims | PMID is actually |
|---|---|
| Roodenrys 2016, Bacopa & memory | **methylsulfonylmethane for allergic rhinitis** |
| Li 2020, Lion's Mane & cognition | **ivermectin in ovarian cancer** |
| Ye 2021, berberine & blood glucose | **naringin in pulmonary hypertension** |
| Hariri 2021, Vitamin K2 & bone | **IV zanamivir for influenza** |
| Anderson 2020, chromium & glycemic | **adalimumab retention in uveitis** |
| Auld 2017, melatonin & sleep latency | **mesenchymal stem cells in ovarian tissue** |
| Kim 2018, Panax ginseng & cognition | right journal, wrong paper (ginseng in RA) |
| "NIH studies on magnesium and sleep" | a real 2012 trial, but **not NIH** |

Four were correct. The UI presents these with a ✅ and a *"✅ APA-formatted references with PMID from
PubMed"* badge (`ResultsPage.jsx:271`). `RRL_COMPLIANCE_IMPLEMENTED.md:69` explicitly claims
**"✅ Evidence citations are verifiable via PMID."**

Its own verification procedure (`:76-77` — *"Verifying PMIDs are real via pubmed.ncbi.nlm.nih.gov"*)
**was never run.**

### 🔴 2.2 Cross-user health data leak

```js
// supplement_detail.js:132
const cacheKey = `supplement-ai:${nameKey}`;   // supplement name ONLY
const detail = await dedupe(cacheKey, async () => { … });
```

`dedupe` returns the in-flight promise for the same key to **any concurrent caller, regardless of
user identity**. But the prompt (`:55-96`) embeds age, gender, symptoms, medical conditions,
allergies, pregnancy status.

User A (26F, shellfish allergy) and User B (65M, warfarin, CKD) click "Magnesium" within 20s →
**both get the same personalised guide, generated from whichever profile arrived first** — and it's
cached in their browser for 30 days.

Worse: your own `SECURITY_AUDIT_REPORT.md:358` signed this off — *"SupplementDetail cache is shared
across users — **By design.** Only non-personalized guides are written to it."* The DB guard is
correct; the `dedupe` path has no such guard and is the only live path.

**One-line fix:** include user id in the key when personalised.

### 🔴 2.3 No crisis detection in the AI chat

`server/utils/chatSafety.js` is 177 lines of pure **input-shape** validation. Grep for
`suicid|self.harm|chest pain|crisis|helpline` across `chat.js` + `chatSafety.js`: **zero matches.**

But `severity.js:28-32` defines exactly the right list:
```js
const RED_FLAG_PHRASES = ['chest pain','difficulty breathing','faint','suicid',
  'self-harm','severe pain','emergency','blood in stool','coughing blood'];
```
**Applied only at assessment-submit. Never imported by `chat.js`.**

A user types *"I've been having chest pain and I feel like I want to die"* and the assistant — whose
system prompt (`chat.js:137`) says only *"Answer health questions fully… never diagnose"* — answers
it. No crisis banner, no hotline, no escalation.

The app *has* Philippine crisis numbers hardcoded (`recommend.js:214,217` — DOH 1550, NCMH 1553) —
but routes them only behind a "Recreational Drugs" checkbox. **The highest-risk user (typing into a
chat box rather than filling a form) gets the least protection.** There is no `chatSafety` test file.

### 🔴 2.4 The AI veneer: a ~575-line hardcoded engine with no provenance signal

`generateClinicalFallback()` (`recommend.js:363-937`) emits the *identical* response shape as the
LLM — dosages, priorities, citations, schedules, disclaimers. It fires whenever the AI is
unconfigured **or on any fetch/parse error**.

**The response carries no flag saying which engine produced it.** Client can't tell, admin can't
tell, nothing is logged user-visibly (only `console.log` at `:317`). A demo with no
`OPENROUTER_API_KEY` shows a fully-populated, PMID-cited clinical plan.

The purest example (`:1188`), emitted for any supplement the `if`-chain misses:
> *"Supported by peer-reviewed research from 2020-2025 indexed in PubMed and current
> evidence-based guidelines from the NIH Office of Dietary Supplements…"*

**That is a citation for a citation.** No paper, no author, no year, no identifier.

### 🔴 2.5 Input is defended; output is not

- `recommend.js:282` — `JSON.parse` → `res.json(sanitizeStrings(aiResult))`. `sanitizeStrings`
  only rewrites Unicode punctuation. The LLM's `dosage` goes to the user verbatim, rendered under a
  "💊 Take" label.
- `supplement_detail.js:183` — a hallucinated contraindication becomes a `considerations[]` entry
  rendered as a safety list. **Indistinguishable from a real one.**
- `chat.js:235` — raw text through a hand-rolled markdown renderer.

There is **no ground-truth corpus**. Input validation on a prompt-injection defence without output
validation is security theatre — the attacker doesn't need a jailbreak, they just need the model to
be wrong, and nothing notices.

### 🟠 2.6 Half the safety rules can never fire — a broken enum contract

The rule engine compares against strings the frontend **does not send**:

| Rule checks | Frontend sends |
|---|---|
| `'Kidney Disease'` | `'Chronic Kidney Disease'` |
| `'High Blood Pressure'` | `'Hypertension (High Blood Pressure)'` |
| `'Depression/Anxiety'` | `'Depression'` + `'Anxiety Disorder'` (separate) |
| `'Anxiety/Stress'` | `'Anxiety / Excessive Worry'` |
| `'Poor Sleep'` | `'Sleep Disturbances'` |
| `'15-30 min'` (hyphen) | `'15–30 min'` (en-dash) |
| `'Athletic Performance'` | not an option at all |

**Live consequences (AI-disabled path only):** a CKD patient gets **no potassium avoidList, no
magnesium cap, no nephrologist warning** — and instead receives the general adult **Magnesium
Glycinate 300-400 mg** (`:934`). Magnesium accumulates in renal impairment.

Smoking gun that it's a drift bug, not a design choice: `buildMealRecs` in the **same file**
(`:1363`) correctly uses the frontend's spelling. And `isAdult` is declared at `:434` and never
used.

**And `recommend.js` has zero test files.**

### 🟠 2.7 Age / pregnancy / drug-interaction gates exist only on the fallback

`AGE_AWARE_TOOLTIP.md` claims *"NEVER adult doses for infants."* True — in the **fallback**
(`:438-521`, genuinely good work: infants get Vitamin-D-drops-only with a pediatrician mandate).
But the AI path has **no age gate**; it's one prompt line (`:142`).

Drug interactions are **six regexes** (`recommend.js:414-419`): warfarin, statin, thyroid, metformin,
SSRI, ACE-inhibitor. No CYP modelling, no MAOIs, no opioids, no DOACs beyond two. `"not taking
warfarin anymore"` matches.

### 🟠 2.8 The Wellness Score is an invented instrument measuring *engagement*

```js
// dashboard.js:33-52
adherencePoints = Math.round(adherence * 0.5);          // 0-50
streakPoints    = Math.min(Math.round(streak * 0.67), 20);  // 0-20
return Math.min(baseline + adherencePoints + streakPoints, 100);
```
And the 0-30 baseline is **LLM-generated** (`recommend.js:166`).

No SF-36, no WHOQOL, no PROMIS, no published weighting. Three incompatible constructs added as if
commensurate: **how unhealthy you are**, **how obediently you tick boxes**, **how many days in a
row**. A user with a chronic illness who takes every dose scores **100/100** — the top wellness band.

### 🟠 2.9 Prompt-injection probe is a tautology

Six regexes (`recommend.js:10-19`). The self-test (`attack_probes.js:258-267`) feeds **the exact
string from the regex's own alternation**, then reports `status: 'healthy'`. The probe can only fail
if the regex it reads was deleted.

> **Panel question:** *"Your security centre tests the injection filter by feeding it the string the
> filter was written for. What happens when I type 'disregard the prior directives above'?"*

### 🟡 2.10 The AI chat is stateless — no transcript, no history, no audit, no user control

A user asks *"is this safe with my warfarin?"* — and the transcript is **never stored**. For a health
app that's arguably worse than not having the feature. GDPR/HIPAA access and erasure both fail
trivially. The server cannot audit what it said.

### 🟡 2.11 Health data is plaintext, on the same DB and credentials as everything else

`Assessment` stores symptoms, conditions, medications, allergies, pregnancy status, blood test
results as **plaintext**.

The self-incriminating contrast: the codebase contains **`server/utils/secretBox.js`** — 261 lines
of versioned, key-fingerprinted, AES-256-GCM envelope encryption with a production hard-fail. It is
used for **TOTP seeds**. Health data gets none of it.

### 🟡 2.12 "RRL compliance" is a prompt sentence, not a regulatory control

**RRL = "Related Research Literature"** (`RRL_COMPLIANCE_IMPLEMENTED.md:4`) — a citation-recency
policy. There is **no FDA, PFDA, or DOST anywhere in the codebase**. It's a prompt block plus a
hardcoded string table. No PubMed call. No verification.

### ⚪ 2.13 Other

- Duplicate dead code blocks: Anemia, PCOS, Osteoporosis, Depression, Celiac, Gout written twice
  with different content (`recommend.js:600-672` vs `:673-723`) — users see contradictory
  interaction text.
- Mojibake `\uFFFD` in user-facing clinical copy, "fixed" by a client-side `fixChars()` that
  **mangles data instead of fixing source** (`ResultsPage.jsx:12-27`).
- `recommend_improvements.js` is 183 lines of **entirely unreferenced** code parked in `routes/`,
  presenting itself as delivered functionality in 3 other docs.
- `InsightsPage.jsx` renders AI-generated **predicted health outcomes** with **no disclaimer
  anywhere** (0 grep matches for disclaimer/medical advice/consult).

### ✅ What to defend

**`priorityFlagging.js` is the best file in the repository.** The invariant — *the model can only
escalate, never clear* (`:26-49`) — is the correct asymmetry for clinical triage, enforced
structurally, with a confidence floor, a "must cite a reason" rule, and every failure mode degrading
to "the rules stand". The rationale is written down: *"The safe direction to be wrong in is flag too
much."*

Also strong: `aiRouter.js` (excellent infrastructure — **misapplied**, see below), PII minimisation
in prompts with a tripwire probe, server-owned chat context, schema-derived delete cascade.

> **The capstone story is not "this is a bad AI project." It is: *the team knew exactly what right
> looked like, built it once, and then let three hand-rolled `fetch` calls and a 2,300-line string
> table bypass it.*** `recommend.js:243`, `polish.js:70`, `supplement_detail.js:144` all hand-roll
> `fetch` instead of using `aiRouter`.

---

## Category 3 — Security & Authentication

### 🔴 3.1 Live credentials in a public repo, never rotated

```js
// server/scripts/restore-lost-account.js:44-52
email: 'verbojanrich20@gmail.com',
password: 'Janrich@101.com',        // PLAINTEXT, in a TRACKED file
```
```js
// server/scripts/send-admin-credentials.js:6-8, 244
npm run send-admin-credentials -- --password AdminDevs=Devs101
```

Remote is **public** (`github.com/REIIdes/SuppliWise`, confirmed via `.git/logs/HEAD:1`). Your own
`securityAudit.js:240-244` still lists four `URGENT:` rotations — **six commits later, none done.**

**Framing:** *"We detected this, we sanitised the working tree, and we have not yet completed the
history rewrite — that's the honest state."* Never say the incident didn't happen.

### 🔴 3.2 `npm start` never sets `NODE_ENV=production`

`server/package.json:10` → `"start": "node index.js"`. `server/.env` sets no `NODE_ENV`.

**Every production guard silently never fires:** the JWT-strength check, the `ALLOW_DEV_OTP_RESPONSE`
block, the `PUBLIC_WEB_URL` requirement, `assertProductionConfigured()` for CORS, and the
TOTP-key-must-not-derive-from-JWT check (`index.js:103-111`). You ship the *weak* configuration via
the *documented* path.

### 🟠 3.3 `Host: localhost` gets development rate limits in production

```js
// utils/floodGuard.js:40-46
isLocalDevRequest = NODE_ENV !== 'production' || req.hostname === 'localhost' || req.ip.includes('127.0.0.1')
```
`req.hostname` comes from the **`Host` header**. Send `Host: localhost` to a production server →
`AUTH_RATE_LIMIT_MAX` 200 instead of 20, `GLOBAL_MAX` 12000/min instead of 1200.

### 🟠 3.4 The MFA attempt budget is dead code — and the test can't prove otherwise

`attempts` is set to 0 (`mfaTransaction.js:79`) and **never incremented anywhere**. So
`$expr: {$lt: ['$attempts', '$maxAttempts']}` is always `0 < 10` → always true.

Three files assert a 10-attempt budget that doesn't exist. And the test that "proves" it:
```js
// Test File/mfa-transaction.test.js:261
assert.ok(after.status === 401 || after.status === 429, ...);
```
A disjunction that passes if *either* layer worked. The comment even admits why: *"The account
lockout ladder may well answer 429 before the per-transaction budget is reached."*

### 🟠 3.5 Admin TOTP seeds stored in plaintext base32

`models/AdminAccount.js:6`. The entire `secretBox` migration was applied to `User.twoFactorSecretEnc`
and never to admins — **to the lower-privileged half of the identity space.** A DB read mints valid
codes for every administrator.

### 🟠 3.6 Unauthenticated account-lockout DoS

3 wrong passwords → 15 min → 1h → 6h → **24h**, keyed only on the victim's email, **no proof of
knowledge, no IP/session binding** (`lockout.js:299, 302-317`). Offense decays after 30 days.

Notably, the OTP bucket *is* capped at 1h with careful reasoning (`:130-143`) — that same mitigation
was never applied to the password bucket.

### 🟠 3.7 `/admin-login` has no timing equaliser → admin alias enumeration

An unknown alias returns 401 after a `findOne` miss. A known alias with a wrong password runs a full
argon2id verify. **The codebase already has the fix** (`burnPasswordCompare`, `password.js:81`) —
applied only at `/login`, not `/admin-login`.

Plus: aliases are short human-chosen strings (`AdminDevs`, `AdminJoma`) sitting in a committed file.
The "unguessable identifier" argument that protects `webauthnUserId` doesn't hold for admins.

### 🟠 3.8 User sessions never expire

```js
const USER_SESSION_EXPIRES = false;                              // userSession.js:61
function signUserToken(...) { /* signs NO exp */ }               // sessions.js:130-135
```
A stolen bearer token is valid **forever** until the victim happens to sign in again.

The justification in the comment — *"threats are not meaningfully reduced by 30 days rather than
31"* — is weak. The `Session` model already supports an absolute cap (`:140-143`); nothing uses it.

**Three security documents disagree about this** (see Category 9).

### 🟠 3.9 Admin token in `localStorage`, while CSP keeps `unsafe-inline`

The *user* token was deliberately moved to per-tab `sessionStorage` (`authState.js:29`,
`api.js:678-714` actively strips legacy localStorage mirrors). The **highest-privilege** token got
the storage model the team explicitly migrated away from. 15+ direct reads/writes bypass any
abstraction, and it self-renews on a timer.

Combined with `script-src 'unsafe-inline'` (`index.html:58`) → any XSS yields a **persistent,
auto-renewing admin token**.

### 🟡 3.10 Every rate limiter is in-memory and IP-keyed

One custom `keyGenerator` in the whole codebase (`routes/chat.js:22`). Everything else uses
express-rate-limit's default `MemoryStore` + `req.ip`.

Consequences: all limits reset on restart; N replicas = N× the budget; the lockout ladder
(`lockout.js:86 buckets = new Map()`) and the **TOTP replay cache** (`totp.js:6`) all disagree
across instances. `400 req/15min` for `/auth/me` is shared across **every user behind one NAT**.

### 🟡 3.11 User enumeration oracles

- `POST /register` → `400 "Email already registered."` (`:481`) — textbook oracle.
- `/resend-password-reset-otp` → **401** for unknown userId vs **200** for known (`:1541-1548`).
- `/verify-login-otp` → four distinguishable messages (`:1081-1122`).

You explicitly closed the forgot-password one and left these open.

### 🟡 3.12 `/api/health` doesn't check the database

```js
app.get('/api/health', (req, res) => res.json({ status: 'Server is running' }));   // index.js:466
```
Returns **HTTP 200 from a process that cannot serve a single request.** No `/ready`, no `/live`
split, no graceful shutdown handler anywhere (`mongoose.disconnect()` and
`bigDocuments.closeBulkConnection()` are dead exports).

### 🟡 3.13 Uploads accept any bytes and any remote URL

No `multer` — images arrive as base64 and are decoded in `pictures.js`. **No magic-byte validation:**
the declared MIME is trusted and the extension derived from it.

And `pictures.js:167` accepts **any absolute http(s) URL** as an avatar — a **server-side-stored
tracking pixel**: point a victim's avatar at `http://attacker/x.gif` and learn their IP/UA/view-time
from inside your own UI.

### ⚪ 3.14 Dead safeguard, duplicated routes, contradicting comments

- `ALLOW_DEV_OTP_RESPONSE` is checked (`index.js:75-77`) but **the feature is never implemented** —
  a guard protecting nothing, creating false assurance.
- `POST /auth/{setup,verify,disable}-2fa` duplicate the `/totp/*` versions **and are weaker** — no
  `requireStepUp`. Both routes are live.
- `routes/sessions.js:10` header still says sessions end "after 30 days"; that window was
  deliberately removed.
- `User.password` is **not** `select: false` while `twoFactorSecret`, `lastLoginIp`,
  `currentSessionId` all are. One careless `res.json(user)` ships the argon2id hash.
- `PUT /api/auth/profile` has **its own, weaker password policy** (8 chars, no lowercase, no symbol)
  despite `passwordRules.js` existing specifically to prevent that drift.

---

## Category 4 — Data Persistence & Atomicity

### 🔴 4.1 There are no MongoDB transactions anywhere

`grep startSession|withTransaction` → **four hits, all the English word "session" in comments.**
The codebase has never used a `ClientSession`.

Justified in exactly one place (`supportChat.js:87-93`): *"the deployment runs standalone Mongo,
where transactions need a replica set."* Legitimate — but applied to 1 call site out of dozens, and
contradicted by your own comments referencing Atlas (which **does** provide a replica set).

### 🟠 4.2 Subscription state machine is read-modify-write with no version check

```js
// subscription.js:273-291 — purchase
const user = await User.findById(req.user._id).select(SUBSCRIPTION_SELECT).lean();
const result = subState.applyAction(user.subscriptionRecord, 'setPaid', {...});
await User.findByIdAndUpdate(user._id, { $set: { subscriptionRecord: result.record, ... } });
```
No filter guard, no `__v` check, no `$push`. Two concurrent purchases both read, both compute, both
`$set` — **last write wins, and one history entry is silently destroyed even though it was
"appended."** `optimisticConcurrency` is not enabled on any schema.

This is the shared path for **all ten admin grant/extend/deduct/restore actions**.

### 🟠 4.3 `Wallet.transfer()` is a hand-rolled two-phase commit

```js
// engine.js:242-268
const debited  = await Wallet.findOneAndUpdate({address: from, balance: {$gte: value}}, {$inc: {balance: -value}}, {new: true});
const credited = await Wallet.findOneAndUpdate({address: to}, {$inc: {balance: value}}, {new: true}).catch(() => null);
if (!credited) {
  await Wallet.updateOne({address: from}, {$inc: {balance: value}});   // unguarded rollback
  throw new EngineError('NO_WALLET');
}
```
If the process dies between the debit and the rollback, **tokens are destroyed with no compensating
credit and no record.** The comment at `:240` calls this "Atomic two-sided transfer." It is not.
This is precisely what `withTransaction` exists for — and it's money-shaped.

*(Credit where due: `debit()`, `stake()`, `unstake()`, `accrueStake()` all use **conditional atomic
updates** with an optimistic-concurrency guard. Someone did think about double-spend. `transfer()`
is the one that was missed.)*

### 🟠 4.4 Dashboard `GET` performs five writes

`GET /api/dashboard` does: `User.findByIdAndUpdate({hasVisitedDashboard})` (:92), `metrics.save()`
(:75), `IntakeRecord.bulkWrite` upsert up to 20 docs (:172-181), a re-read (:186), `metrics.save()`
again (:208).

`userLimiter` allows 120 req/min/IP, so a polling client generates up to **120 writes/min on a route
named GET**. And two concurrent polls can interleave `validateStreak`'s read-modify-`save`
(:62-77) and corrupt the streak counter. `metrics.streakAwardedToday` is a *hoped-for* idempotency
key held in the document instead of a unique index.

6-8 round trips per dashboard load. Your own comment (`dashboard.js:124`) says "Atlas RTT ~0.5s each."

### 🟠 4.5 Unbounded arrays will hit the 16MB document limit

`KnowledgePost.upvoters`, `Proposal.votes`, `SupplyBatch.events`, `SupplyBatch.certifications`,
`Block.txs` — all `$push`, **no schema-level bound.** `knowledgeUpvoteCap: 40` is a *reward* cap, not
an array cap (`govern.js:355-366` reads it then `$push`es regardless).

The near-limit one is `SubscriptionRequest.proof` — a **~2.7MB base64 data URL**, 8 requests per
10 min per IP, no TTL, no archival. Every admin approval pays a multi-megabyte round trip.

### 🟡 4.6 `SecurityEvent` grows forever; the documented sweeper was never written

```js
// models/SecurityEvent.js:136-139
// A scheduled sweep removes them; nothing in the read path depends on the cap
securityEventSchema.index({ createdAt: 1 });
```
`grep setInterval|node-cron` over `server/` → 4 hits, **none of them this**. **An index exists for a
job that was never written.** A reviewer reading that comment will believe retention exists.

### 🟡 4.7 Three implementations of account deletion, none complete

`User.js:398-432` and `:434-456` each hand-maintain 7 models. `admin.js:51-76` maintains a
*derived* list of 30. `admin.js:523-528` runs them as a **30-way `Promise.all`** of `deleteMany`.

Die at delete 17 → account gone, 13 collections retain orphan rows. **Picture files are never
deleted** — no `unlink` in production code.

### 🟡 4.8 Missing indexes on hot paths

- `IntakeRecord` has **no index on `{user, assessment, date}`** — the insights 7-day trend scans
  every record for the assessment (~27,000 docs with your own 5-year retention).
- `Assessment.priority` is unindexed despite **four hot queries** including every notifications poll.
- `admin.js:320-327` runs an unanchored case-insensitive regex over 3 fields → full collection scan,
  every keystroke.

### ⚪ 4.9 ~30 empty `.catch(() => {})`, and some are money

Most are deliberate. Two are not: `web3/market.js:139,398` silently restore marketplace stock after
a failed order (a lost increment is permanent oversell), and `market.js:233` records a resolved
dispute with no settlement tx.

**`AdminEvent.js:4-10` documents that this exact pattern already shipped and silently lost every
subscription audit row** — because the enum was missing and the fire-and-forget catch swallowed the
validation error. The failure mode is live, not theoretical.

### ✅ Strengths

- **`select: false` on every sensitive field** except `password`.
- **`SecurityEvent.write()`** — a closed-vocabulary writer with a `META_KEYS` allowlist
  (`:162-181`), so a caller **cannot** smuggle a secret into the audit trail. Excellent control, and
  the comment at `:141-155` documents the `Schema.prototype.create` bug that had silently killed
  the whole log.
- **No NoSQL injection surface**: no object from `req` is ever spread into a Mongoose filter; every
  `$` operator is server-authored. `dashboard.js:12-18` documents the `str()` mitigation.
- **`entitlements.js:59-72`** documents and fixes `FEATURES['constructor']` returning a truthy
  inherited member that made `can()` **fail open**. Found and fixed on both sides.
- Admin N+1s deliberately eliminated with grouped aggregates and `$facet` (`admin.js:356-371`).
- **404-not-403 for ownership, applied consistently** across every scoped route.
- `planCatalogue.js:479-492` — the catalogue cache **refuses to cache the payment destination** and
  explains why in four sentences. A model answer.

---

## Category 5 — Subscriptions / Billing

### 🔴 5.1 There is no payment integration. At all.

`server/utils/paymentInstructions.js` is the entire "payment layer." It reads six env vars and
returns `{available, method, accountName, bankName, accountNumber, …}`, served on the **public,
unauthenticated** `GET /api/subscription/plans`.

Set `PAYMENT_ACCOUNT_NUMBER=09xx…` and the pricing page tells users to transfer money and **upload a
screenshot**. `paymentCopy.js:129-143`: *"Transfer the exact amount shown, then upload the receipt
here. An administrator will check it."*

**The business/legal exposure:**
- No processor, no webhook, no reconciliation, no gateway reference field.
- **Manual verification of a screenshot is not a payment control.** A forged or recycled GCash
  receipt is indistinguishable from a real one. No amount cross-check, no reference match, no
  duplicate-payment detection. The admin queue shows `formattedAmount: '₱499'` next to whatever image
  was uploaded.
- **No refund path exists at all.**
- **No `Payment` collection anywhere.** The only record of what a customer paid is
  `subscriptionRecord.history`, **capped at 40 entries**. Buy 41 times, lose the first entry.

**Reframe honestly:** *"This is a manual-payment grant system, not a subscription billing system. Our
capstone scope was the entitlement and state machine, which is complete and correct."* — which is
true, and is a legitimate scoping statement.

### 🟠 5.2 `SUBSCRIPTION_SELF_SERVE_PURCHASE=true` grants a paid plan for ₱0

`planCatalogue.js:547-551` → `subscription.js:216-347` grants the top tier with no charge. The
"receipt" at `:317-334` is a *computed number* printed to the log, never verified.

`index.js:655-661` prints a boot warning. **And this variable is not in `.env.example`.**

### 🟠 5.3 Hardcoded FX rates, presented as authoritative prices

```js
// planCatalogue.js:71-82
USD: { rate: 58.5 }, EUR: { rate: 57.0 }, GBP: { rate: 75.0 }, JPY: { rate: 0.40 }, …
```
Static constants. No feed, no timestamp, no staleness check. `planCatalogue.js:106-107` openly maps
**Indonesia, Thailand, Vietnam, Taiwan, Cambodia, Laos, Myanmar → PHP** ("priced in PHP until a real
per-country price list exists") in a Southeast-Asia-weighted product.

A ₱1,600 plan advertised as **£21.33** is a *quote*, not a price — and a customer who pays £21.33 to
a Philippine account has been mis-sold by the app.

### 🟠 5.4 Marketing copy contradicts the billing reality

`PricingPage.jsx:1116` prints **"Billed monthly · cancel any time"** on every paid card, and
`planCatalogue.js:294,309,324` carries `priceNote: 'Billed monthly'`.

**Neither is true.** A purchase is a one-shot 30-day grant. Nothing renews. There is no dunning, no
failed-payment recovery, no proration, no refund, no invoice. Cancelling revokes access **immediately**
with no credit (`subscription.js:617-667` — and the member's response says only *"Your plan has
ended"*; the forfeited days are logged for the admin, never shown to the user).

Also: `yearly` is a 12-month prepay at `months * 30` = **360 days**, charged at the yearly price.
360 vs 365 is a real, disputable discrepancy.

### 🟡 5.5 Two doors to cancellation, one bypassing the state machine

`POST /cancel-requests {mode:'immediate'}` calls `runCancellation` directly, **bypassing the
`SubscriptionCancelRequest` CAS** that the review path and admin approval both use. A user with a
pending *review* cancellation can fire the *immediate* path; the stale review row stays pending and
the admin later approves it against an already-free account.

`POST /downgrade` and the immediate cancel are **the same operation on two endpoints**.

### ⚪ 5.6 `moderator` role exists in the UI and grants nothing

`accountRole: 'moderator'` is settable by an admin, displayed in the grid, audited — and **read by
nothing** in the entire server. A control that appears in the UI and does not exist is worse than no
control.

### ✅ Strengths — this is the strongest part of the codebase

- **Entitlement enforcement is genuinely server-side.** One registry (`entitlements.js:38-54`),
  plan-card bullets **derived from the gates** rather than hand-written (`planCatalogue.js:237-262`),
  with a written history of the fabricated claims it replaced (`"3× more usage than Deluxe"` —
  *"capabilities that do not exist in the code at all"*).
- **The Web3 layer is gated at the one place Express can actually enforce it**, with the reasoning
  written down (`web3/index.js:36-51`: sub-routers are all mounted at `/`, so a guard inside one
  runs for every path). A real Express subtlety, correctly reasoned.
- **`pdfExport` — a client-rendered document with no server endpoint — is correctly routed through a
  server gate** (`subscription.js:822-855`) called *before* rendering. The comment names the exact
  threat.
- **The two-layer paid/override subscription model** (`subscriptionState.js`) with a frozen restore
  snapshot, a pure `applyAction` that *"never touches the database — the route does that — so the
  rules stay unit-testable."* Best-engineered module in the repo.
- **Exactly-once compare-and-swap on both admin approval queues** (`admin.js:1413-1430, 1696-1711`)
  with claim release on failure.
- Expiry resolved **at read time** (`entitlements.js:107-117`) — no cron needed, which avoids an
  entire class of bug.

---

## Category 6 — Frontend Architecture

### 🔴 6.1 No modularization at all in Pages/

| File | Lines |
|---|---|
| `AdminDashboard.jsx` | **4,520** |
| `AssessmentPage.jsx` | 2,516 |
| `PricingPage.jsx` | 2,147 |
| `api.js` | 2,186 |
| `mobile-responsive.css` | 2,381 |
| `SecurityStatus.jsx` | 1,416 |
| `ProfilePage.jsx` | 1,608 |

`AdminDashboard.jsx` contains **13 distinct components and ~40 `useState` hooks in one scope.** There
is no `AdminDashboard/` folder — despite the pattern already being understood and applied to four
smaller admin components.

**No state library.** No Redux, Zustand, Jotai, Recoil, MobX. No server-state cache — no React Query,
no SWR. `package.json` confirms: only `react`, `react-dom`, `react-router-dom`, `axios` (unused),
`jspdf`, `react-icons` (unused), `@capacitor/*`, `@simplewebauthn/browser`.

### 🔴 6.2 Almost no request cancellation → real race conditions

`DashboardPage.jsx:175-235` — `fetchDashboardData` has no abort and no sequence guard, and is called
from mount, from `visibilitychange`, **and recursively** from `handleSupplementToggle`. A slow
initial response overwrites fresher optimistic state.

Only 4 of ~30 page effects cancel. Compare with the technique that *does* exist in
`SecurityStatus.jsx:1076-1125` (`inFlightRef` + `requestSeqRef`) — **the team knows how, it just
isn't the house style.**

### 🟠 6.3 Two auth architectures side by side

The user session is genuinely well engineered: per-tab `sessionStorage`, BroadcastChannel handoff,
dead-token fingerprinting, transition flags, and a load-time migration that strips legacy
`localStorage` mirrors (`api.js:678-714`). The comment block at `authState.js:50-88` documents that
the failure mode this prevents — an admin tab inheriting a user session — **has already happened**.

Then the admin token is a bare `localStorage['adminToken']` read in **15+ places** with no
abstraction, no BroadcastChannel, no migration, no handoff.

And there's **no global 401 interceptor.** `handleAuthError` is only reachable through `api.js`'s
~90 functions. Six raw `fetch` calls in `ProfilePage.jsx` (`:361,385,424,538,607,727`) bypass it
entirely — **so "a 401 clears this tab's session" is false for the profile page**, which is exactly
where 2FA and password changes live.

### 🟠 6.4 Client/server validation drift that the codebase already fixed once

`utils/passwordPolicy.js:5-8` has a header comment describing *exactly this bug being fixed.*
**And it is still present:**

| Location | Rule enforced |
|---|---|
| `server/utils/passwordRules.js:37` | **10+ chars**, uppercase, lowercase, digit, symbol, non-common |
| `my-react-app/src/utils/passwordPolicy.js:17-29` | mirrored, labelled *"keep in sync"* |
| **`SignIn.jsx:29-36`** | **8 chars, one uppercase, one number** |
| **`AdminChangePassword.jsx:4435,4443`** | **"Min. 8 characters, one uppercase letter, one number"** |

A user fills in a form the client approves; the server rejects it.

Also: four copies of `relativeTime`, two copies of `fixChars`, **four separate `ConfirmModal`
implementations**, two API clients (`api.js` with 401 handling, `api/web3.js` without — despite its
header claiming "left to api.js's global handling," which doesn't exist).

### 🟡 6.5 Accessibility: no tooling whatsoever

No `axe`, no `jest-axe`, no `@testing-library`, no `eslint-plugin-jsx-a11y`. There is **no automated
way an a11y regression is caught.**

Concrete failures:
- **Keyboard-unreachable:** `HistoryPage.jsx:792` — `<div onClick>` expands a card, with no `role`,
  no `tabIndex`, no `onKeyDown`. **The entire history list cannot be expanded by keyboard.** (Line
  934 in the same file *does* get `tabIndex` — so the pattern was known.)
- **No focus trap in most modals.** `ConfirmModal.jsx:18-24` handles Escape but never moves focus in
  or restores it. Only `ImageLightbox.jsx` and `ProfileActionsMenu.jsx` do it properly.
- `SupplyPanel.jsx:130-246` — 8 inputs with `placeholder` + `aria-label` but no visible `<label>`.
- `ChatAssistant.jsx:470-476` — connection state has no `role="status"`/`aria-live`, so a screen
  reader never hears "Reconnecting."

### 🟡 6.6 Responsiveness is an `!important` arms race

`mobile-responsive.css` is 2,381 lines, 27 `@media (max-width: 768px)` blocks, nearly every
declaration carrying `!important`. The navbar background is declared **twice** in that file (`:73`,
`:88`), and again in **eight per-page CSS files** — so the navbar surface is declared in three
places, which is exactly the bug `navbarSurface.test.js` was written to prevent.

The comment at `:76-86` is a confession:
> *"an important declaration beats an ordinary one regardless of source order — so without this rule
> the bar would keep the unscrolled shadow on a phone forever."*

**The team won by escalation rather than by structure.**

### 🟡 6.7 Silent catch blocks that make the UI lie

- `InsightsPage.jsx:106-116` swallows the error then sets `hasAssessment(false)` → a network failure
  renders the "no assessment yet" empty state. The code comments on it openly:
  `// No assessment on error`.
- `UserNotifications.jsx:51-55,194-196,214-216,240-242,254-256` — **five** silent catches around real
  mutations. The user clicks "Delete all read", the server 500s, and the UI silently lies.

### ⚪ 6.8 Dead code and duplication

- **`Components/PWAInstallPrompt.jsx` (93 lines) is entirely unreferenced.** The install prompt the
  app claims to have **does not run.** `PWA_SETUP.md:27` documents it at a path that doesn't exist.
- `axios` and `react-icons` are declared dependencies with **zero imports**.
- Two competing manifests (`public/manifest.json` + inline in `vite.config.js`).
- `vite.config.js:115-143` has runtime caching for Google Fonts while `index.html:54` states there
  are none. **Both rules cache nothing.**
- **The root `package.json` is a 6-line phantom** declaring `react-icons` + `react-router-dom` (both
  already in `my-react-app/package.json`), with `"name": "Capstone Project"` in its lockfile — and
  the two locks **disagree on React major** (19.2.6 vs 18.2.0).

### 🟡 6.9 A full Android native project is committed, including build output

`my-react-app/android/` contains gradlew, the wrapper jar, `MainActivity.java`, and
**`app/src/main/assets/public/` with ~80 files of built JS/CSS.** The root `.gitignore` covers
`dist` and `dev-dist` but **has no `android` entry.**

Plus `"cleartext": true, "androidScheme": "http"` in `capacitor.config.json` — the shipped APK
permits cleartext HTTP. And empty `"keystorePath": ""` / `"keystoreAlias": ""` — signing was never
wired up.

Capacitor is being used purely as an APK wrapper: no plugins, no secure storage, no offline.

### ✅ Strengths

- **Code splitting is genuinely good** — 24 of 27 routes lazy-loaded, jsPDF (~350KB) deliberately
  kept out of every route chunk, `@simplewebauthn/browser` dynamically imported, with
  `optimizeDepsInclude.test.js` enforcing the invariant.
- **A real `ErrorBoundary`** with `getDerivedStateFromError` *and* a stale-chunk self-heal
  (`reloadOnceForStaleChunk`). Better than most student projects.
- **`useScrolledPast.js`** reads scroll position once per *crossing*, not per frame; `passive`
  listener; initialises from `window.scrollY` so restored offsets don't flash.
- **`useSubscription.js`** (524 lines: SSE, BroadcastChannel relay, backoff, expiry watch, race-free
  `commit()`) is a hand-written Zustand-shaped store — and it has **no tests at all**.

---

## Category 7 — Scalability & Performance

### 🔴 7.1 The ledger has no cross-process coordination

`ledger.js:94-109` keeps `this.height`, `this.tip`, `this.queue` as **in-process instance state**,
and `init()` caches the promise forever. Two instances behind a load balancer both read the same tip
at boot, both compute `index = height + 1`, both mine at the same index → one gets `E11000` on the
unique index, **or both interleave and `prevHash` linkage silently diverges from `this.tip`.**

**The "immutable, tamper-evident, auditable chain" is a single-process mutex serialising an in-memory
counter.**

### 🟠 7.2 Boot performs an O(chain) full audit, and the chain grows forever

```js
// ledger.js:254
const blocks = await Block.find({}, VERIFY_PROJECTION).sort({ index: 1 }).lean();
```
Loads **every block into Node memory.** No pruning anywhere. Runs every 5 minutes and on every admin
monitor poll. The file's own comment reports 4.7s for a 1,746-block chain.

`ledger.append()` is called on **every** Web3 state change — credit, debit, transfer, stake,
unstake, accrual, NFT mint, vote, propose, consent, storage pin, health anchor.

**This is an unbounded-growth cliff that will eventually OOM the process.**

### 🟠 7.3 PoW mining blocks the event loop on every Web3 write

`ledger.js:61-67`, `MAX_NONCE = 1 << 26`. At difficulty 3 it's ~4,096 iterations — single-digit ms,
every write. At difficulty 5 (the max one env var allows) it's ~1M iterations — **seconds of hard CPU
block, on a request thread.** In the pathological case, minutes.

### 🟠 7.4 SSE: unbounded connections, token in the query string, dead expiry timer

```js
// subscription.js:72-77
if (!req.headers.authorization && req.query.token) {
  req.headers.authorization = `Bearer ${req.query.token}`;
}
```
`middleware/auth.js:182-189` explicitly documents that query-string tokens are *"deliberately NOT
accepted"* because *"URLs leak into proxy/access logs, browser history, analytics and Referer
headers"* — and then carves out this one exception.

- **No connection cap.** `bus.subscribe()` adds to a `Set` with no limit. One client can open
  thousands of sockets, each holding an fd, a 25s heartbeat, and a `close` listener.
- **The expiry timer never arms.** `subscription.js:905-913` reads `jwt.decode(raw)?.exp` — but user
  tokens carry **no `exp`** (`sessions.js:130-135`). The comment describes behaviour that doesn't exist.
- The bus is a process-local `Map`, and its own header admits *"single-instance deploy."*

### 🟡 7.5 Every cache, limiter, and lockout is per-process

**Seven separate in-memory caches** with six different invalidation strategies and zero shared
infrastructure: `middleware/auth.js:43` session cache, `cache.js` (2 callers), `geo.js` ×2,
`admin.js:1824` monitor, `systemDetection.js:427`, `aiProviders` health, `bigDocuments.js:82`.

**The app is single-instance-only, and nothing at boot says so.**

### 🟡 7.6 The session cache stores the whole user document → 30s revocation lag

```js
// middleware/auth.js:294
setCachedSession(check.sid, check.user);   // full lean User document
```
Every entitlement gate reads `req.user.subscriptionPlan`. Therefore:

- **A cancelled subscription still passes every plan gate for up to 30 seconds.**
- **A `banned` account keeps working for up to 30 seconds** — the invalidation listener (`:91-96`)
  covers *session* revocation, not *account* revocation.

### 🟡 7.7 `backfillLocations` fires 25 concurrent requests to a free API over plain HTTP

`admin.js:387-388` → `utils/geo.js:179-187`, up to 25 concurrent calls to `http://ip-api.com`.
**Failures are never cached** (only successes are, `geo.js:85,134`), so every unknown location is
retried on every poll. The free tier allows 45 req/min; a 100-user table polled every 10s with 25
unknowns generates **150 req/min against a 45 req/min quota — permanently throttled, forever, with
`.catch(() => {})` making the failures invisible.**

### ⚪ 7.8 Pagination is `limit`/`skip` with no cursor

`assessment.js:332` computes `skip = (page-1) * limit` with `page` clamped to 1,000,000. At the
20-per-page PREMIUM cap that's a **20M document skip.** The comment acknowledges it; clamping to
1,000,000 barely helps.

---

## Category 8 — Testing & Quality Assurance

### 🔴 8.1 The headline features have ZERO tests

| Zero-coverage route | What it is |
|---|---|
| **`routes/recommend.js`** | **the core product feature** |
| `routes/insights.js`, `dashboard.js` | AI insights, main dashboard |
| `routes/securityRedeem.js` | **public** backup-code redeem as 2FA |
| `routes/supplement_detail.js`, `polish.js` | AI deep-dive, output validation |
| **all 9 `routes/web3/*.js`** | the entire blockchain layer |

Plus 31 of 52 utils — **including `server/utils/attack_probes.js`, the 45-probe security monitor
the README and admin UI present as live status. Zero tests.**

And the whole blockchain runtime: `blockchain/{crypto,engine,ledger,rules,seed}.js`.

> **The capstone's two headline features — AI recommendations and the blockchain layer — are the
> least tested code in the repository.** Security-adjacent code is heavily tested. No coverage tool
> exists, so nobody noticed.

### 🔴 8.2 A test that tests a copy of the code, by its own admission

```js
// my-react-app/src/Components/SecurityStatus/securityStatusView.js:1-5
/**
 * …The view helpers below are the exact functions the component uses, so a
 * change in the component has to be mirrored here to be tested — they are
 * the rules, not the rendering.
 */
```
Lines 16-70 **re-declare** `MONITOR_FRAMEWORK`, `MONITOR_LABEL`, `MONITOR_IMPL` and re-implement
`buildVisibleGroups` and `countVisible`. **14 of ~19 tests exercise the copy.** Delete
`SecurityStatus.jsx` entirely and all 14 still pass green.

**A test suite that must be manually kept in sync with the file it claims to cover is a comment with
`assert` in it.**

### 🔴 8.3 Zero CI, zero coverage tooling, zero containers

Exhaustive search: `.github/**` → 0 · `*.yml` → **0 in the entire repo** · `Dockerfile` → 0 ·
`Jenkinsfile` → 0 · `.husky/` → 0 · `dependabot.yml` → 0 · `c8|nyc|istanbul|codecov` → 0.

**You already know this.** `securityAudit.js:217-221` ships it to your own admin dashboard as
finding **I3**: *"Nothing runs the test suite or `npm audit` on push. Adding CI is the cheapest way
to keep this audit honest."*

Docker was attempted and reverted — visible only in `.git/logs/HEAD:45-51`.

### 🟠 8.4 The most valuable tests can't run unattended

`server/package.json` declares **6 scripts; only one invokes a test.** These carry the security
claims and have **no npm script and no CI**:

| File | Requires |
|---|---|
| `glitch-hunt.js` | live server, 120 adversarial probes |
| `glitch-hunt-web3.js` | live server, 132 probes |
| `test-web3-flows.js` | live API **+ writes to `MONGO_URI`** |
| `test-session-flows.js` | live API **+ `MONGO_URI`** |
| `test-ddos-resilience.js`, +5 more | live API |

`glitch-hunt*.js` are cited approvingly in `SECURITY_AUDIT_REPORT.md:577` as *"✅ 120 passed, 0
failed."* **They cannot run without a human starting the server. They are documentation, not tests.**

### 🟠 8.5 The test-DB guard exists (excellently) and doesn't cover the dangerous files

`Test File/testDbGuard.js` is **the best-engineered thing in the repository** — and it exists because
your test suite **twice deleted the live production database** (129 stray users; then
`dropDatabase()`).

It keys on a *separate URI* rather than a database name, refuses when they match, skips rather than
fails when unconfigured, and adds a **static source scan**.

But the static scan only covers `*.test.js`. **Ten files named `test-*` sit outside it**, two of
which connect straight to `process.env.MONGO_URI`. `server/scripts/restore-lost-account.js` exists
*because* of the dropDatabase incident and is itself a `MONGO_URI` writer.

> **The file naming convention actively defeats the safety control.** `test-web3-flows.js` reads as a
> test; it is a script that writes to whatever database `.env` points at.

### 🟡 8.6 `npm run check` covers 44 of ~110 server files

The server's only automated static check is a hand-maintained allowlist of 44 files. **Never
checked:** all 9 `routes/web3/*.js`, all 5 `blockchain/*.js`, 8 routes, 13 of 19 models, 31 of 52
utils. Adding a route requires hand-editing `package.json`.

### 🟡 8.7 Frontend: 22 test files, zero interaction tests

- **Exactly one** component render test (`RecoveryPanel.test.js`), SSR-only, and it documents that
  `useEffect` never runs.
- No `@testing-library`, no jsdom, no Playwright/Cypress, no network mocking.
- **Zero tests cover:** any component that fetches, any route guard, a 401, `ProtectedRoute`,
  `AdminProtectedRoute`, `ErrorBoundary`, `useAuth`, `useSubscription`, or any modal.
- `useSubscription.js` — the single most complex piece of logic in the app — has **no tests**.
- `AdminDashboard.jsx` (4,520 lines) has **no tests**.
- 4 test files **grep the source as text** (`navbarSurface.test.js`, `optimizeDepsInclude.test.js`,
  `adminSession.test.js`, `passkeyChunkHeal.test.js`). Genuinely novel, and they prevent real
  regressions — but they test *text patterns*, and reformatting makes them fail for no reason.

### 🟡 8.8 The admin dashboard serves six hardcoded "PASS" strings

```js
// securityAudit.js:230-237
verification: {
  unitTests:       'PASS — node --test "Test File/*.test.js"',
  syntaxCheck:     'PASS — npm run check',
  productionBuild: 'PASS — vite build (287 modules, PWA service worker generated)',
  lint:            'PASS — eslint: 0 errors (4 pre-existing react-hooks warnings)',
  dependencyAudit: 'PASS — npm audit: 0 vulnerabilities (server and client, prod + dev)',
  devServers:      'PASS — API and Vite dev server both answering 200 after the changes',
},
```
**Six string literals. Nothing computed.** "287 modules" is frozen from one historical build. A panel
reading that dashboard is reading a **snapshot**, not a status page.

---

## Category 9 — Documentation & Git Hygiene

### 🔴 9.1 127 of ~132 files at the repo root are prose

**121 `.md` + 6 `.txt`.** Roughly **70** are point-in-time changelogs named after a single bug fix:
`CHAT_SCROLL_FIX.md`, `LOGOUT_BUTTON_MOVED.md`, `STREAK_GRAMMAR_UPDATE.md`,
`STATUS_CODE_FIX.md`, `DASHBOARD_FIX_SUMMARY.md`…

**Those are commit messages stored as files.**

10+ duplicate guide pairs for the same topic: 7 startup guides, 4 PWA/APK guides, **12 login/OTP
guides**, 4 troubleshooting guides.

`README.md:830-846` documents exactly **14** documents. The other ~113 are unlinked, indistinguishable,
and describe codebase states that no longer exist.

### 🔴 9.2 Documentation that actively contradicts the code

**① Session expiry — three answers, and the worst one is the checklist a new dev runs:**

| Source | Claim |
|---|---|
| `Security_Fixes_and_Analysis.md:79-80` | "Detects 10 minutes of inactivity" |
| `Test File/Security Test Analysis.md:42-43` | "Reduced to a more secure **12-hour** session window" |
| `README.md:385` + `.env.example:226` + `sessions.js:133` | **"User sessions do not expire. There is no idle timer and no `exp` claim."** |

Verified: grep for the idle-timeout constants over `my-react-app/src` returns **only a comment**.
**Two security documents describe a control that was deliberately removed and reversed.**

**② Token storage — the checklist contradicts the architecture:**
`TESTING_CHECKLIST.md:31` → *"Token saved to localStorage"* — while
`docs/DEVELOPER_GUIDE.md:33` → *"**No access token is ever stored in `localStorage`.**"*

**③ Wellness score:** `README.md:92` gives one formula; `QUICK_START_GUIDE.md:327` gives a
**completely different** one.

**④ Hashing:** `Security_Fixes_and_Analysis.md:776` says bcrypt 11 rounds. `password.js:12` uses
argon2id via `hash-wasm`.

**⑤ Password reset** is marked `[ ] Implement`. It is implemented, with a 23-test suite.

**⑥ Broken links:** every link in `Test File/Security Test Analysis.md` resolves to
`server/Test File/server/routes/auth.js`.

### 🟠 9.3 `QUICK_START_GUIDE.md` is not a quick start guide

Its own H1 is **`# Quick Start Guide - Dashboard Functional Update`**. It closes with a list of 7
"Next Steps (Optional Enhancements)" — **all 7 of which are already implemented.**

### 🟠 9.4 No ER diagram, no data dictionary, no architecture diagram

`grep "mermaid|erDiagram|graph TD|sequenceDiagram"` across **every `.md`** → **0 matches.**

`SYSTEM_ARCHITECTURE.md` — which `README.md:845` lists as authoritative — describes **9 pages and 1
component**. The app has ~22 Pages and ~40 Components, plus Web3, admin, subscriptions, support,
security, PWA and a native APK. Zero mention. Its auth description is pre-session-store.

### 🟠 9.5 `.git/config` is genuinely corrupted

```ini
[branch "JDMv5"]          ← duplicate section header
  merge = refs/heads/JDMv3
  merge = refs/heads/JDMv2
  merge = refs/heads/JDMv3
  merge = refs/heads/JDMv4   (×2)
  merge = refs/heads/JDMv5   (×2)
```
Git takes the last one and silently discards the rest. Also: 6 branch renames, `refs/stash`, and
**10 AI-tool checkpoint refs** (`refs/cline/checkpoints/*`, `refs/codex/turn-diffs/*`) intact.

### 🔴 9.6 Commit messages

| Message | |
|---|---|
| `Change Something` | **×2, different SHAs** |
| `Bahala muna kayo sa mobile` | |
| `All New System Kayo na Muna Bahala Hahaha` | |
| `Final For Night Goodnight` | |
| `Almost Final`, `Just Test Not Yet Final`, `Final Patch` | |

**~30 commits total** for 21 route files + 52 utils + 19 models + ~62 frontend components + 51 test
files. A reviewer cannot determine what changed, or bisect a regression.

*Positive:* lines 10-12 of the reflog **do** follow Conventional Commits (`fix:`, `feat:`). The habit
existed and was abandoned.

### 🟠 9.7 One contributor, and the auditor is the same AI family

Every line in `.git/logs/HEAD` is `KlaporeDevs <verbojanrich20@gmail.com>`. **No second contributor
in the entire history.** And `SECURITY_AUDIT_REPORT.md:7` states the audit was performed by
*"Automated code review (OpenCode agent)"* — **the auditor is the same tool family that wrote the
code.** No independent review exists.

### 🟡 9.8 19 un-wired scratch/debug files committed as product files

Including **`server/tools/patch.js`**, whose header explains its purpose is to work around
*"the `edit` tool prov[ing] unreliable for the long comment blocks in this task"* — it is an AI
agent's broken-edit workaround, committed as a source file.

And **`server/routes/recommend_improvements.js`** — 183 lines whose header says
`// "Add these helper functions to the generateClinicalFallback function"`. Grep: **zero importers.**
It sits in `routes/` where every reader assumes live routers live, and 3 other docs present it as
delivered functionality.

`DEBUG_OTP_NOT_WORKING.md:91` instructs the reader to **edit `test-login-endpoint.js` with their own
credentials** — a committed script people are told to put secrets into.

### 🟡 9.9 A stray nested git repo

`my-react-app/.git/` — `refs/heads` and `refs/tags` empty, **no remote, no packed-refs.** An unborn
`master` with no history, inside a project that's already a git repo. Not in any `.gitignore`.
`git status` from the parent can treat `my-react-app/` as a gitlink, producing a broken checkout.

### ⚪ 9.10 `docs/` holds Python with no dependency manifest

`generate_patch_notes.py` needs `python-docx` **and** headless Chrome. No `requirements.txt`, no
`pyproject.toml`. The generated `.docx` and `.pdf` are committed as binaries.

---

## Category 10 — DevOps, CI/CD & Observability

### 🔴 10.1 The deployment doc makes the server refuse to boot

```markdown
<!-- START_SERVERS.md:49-58 -->
PORT=5000
MONGODB_URI=your_mongodb_connection_string     ← WRONG NAME
EMAIL_PASS=your_app_password                    ← WRONG NAME
```
The code reads `MONGO_URI` (`index.js:553`) and `EMAIL_PASSWORD` (`email.js:53`). Following the guide
verbatim produces:
```
[mongo] MONGO_URI is not set — refusing to boot without a database.   ← process.exit(1)
```
Same file hardcodes `cd C:\Users\johnr\SuppliWise\server` — **a different machine's user profile.**

### 🔴 10.2 Batch files that kill every Node process on the machine

```bat
rem force-restart.bat:8
taskkill /F /IM node.exe 2>nul
```
`README.md:738` — *"You need **two terminals running at the same time.**"* That is the deployment
strategy.

### 🟠 10.3 Observability: essentially none

No logging library (no pino/winston/bunyan) — every call is `console.log`. No Sentry. No
OpenTelemetry. No Prometheus/`/metrics`. No request IDs or correlation. No log rotation. No
crash reporting.

**And the 45-probe "security monitor" is not observability:** it probes the app *from the admin's
browser*, so **with no admin logged in, nothing is monitored**; every probe generates real load and
429s every 30s; it has **zero tests**; and it's `console.log`-based like everything else.

### 🟠 10.4 13 env vars are read but undocumented — including the dangerous ones

| Var | Why it matters |
|---|---|
| **`SUBSCRIPTION_SELF_SERVE_PURCHASE`** | **if true, any user grants themselves a paid plan for free** |
| **`MONGO_TEST_URI`** | **the entire test-DB safety system depends on it** |
| `NODE_ENV` | gates four production boot checks |
| `TRUST_PROXY` | unset behind a proxy → **all users bucket into one IP** |
| `CHAIN_DIFFICULTY` | cited in `README.md:238` as documented; absent from `.env.example` |
| +8 others | `WEB_ORIGIN` (controls password-reset links), `LOG_OTP_IN_CONSOLE`, `EMAIL_*`, … |

**Zero** documented-but-unused keys. The gap is one-directional: `envUsage.js` finds *dead*
credentials; nothing finds *missing* configuration.

### 🟠 10.5 `.env` is mutable at runtime via an admin endpoint

`envFile.js:188-235` (`reloadFromDisk`), called from `admin.js:2462`. It overwrites `process.env`
**and deletes keys the file no longer defines.** So an admin POST can change any runtime config —
including `JWT_SECRET` (rotate it and every session dies; set it to a known value and **every token
in the system is forgeable**), `MONGO_URI` mid-request, `PAYMENT_ACCOUNT_NUMBER` (redirect where
customers send money), `TOTP_ENCRYPTION_KEY`.

**No re-validation after reload.** None of the boot checks re-run.

### 🟡 10.6 Pattern: security config is fatal; availability config is a log line

Missing `EMAIL_USER`/`EMAIL_PASSWORD` is only probed **asynchronously** at boot
(`index.js:643-647`). A missing SMTP server means **password reset and login OTP silently fail for
every user**, and the server still boots "healthy."

### 🟡 10.7 Dependency posture

- **`speakeasy@2.0.0`** — last published **2019**, `engines: ">= 0.10.0"`, transitive dep pinned to
  `0.0.1`. It is the **sole TOTP implementation.** Your own audit flags it as I4. Not acted on.
- `axios` and `@vitejs/plugin-basic-ssl` installed, **zero imports** (the latter is commented out).
- Three lockfiles, **no `npm ci` anywhere** — two clones on different days get different trees.
- `SECURITY_AUDIT_REPORT.md:585` claims *"npm audit --omit=dev | ✅ 0 vulnerabilities"* — which
  excludes exactly where the deprecated `glob@11.1.0` and `source-map@0.8.0-beta.0` live.
- No Dependabot, no Renovate, no scheduled audit.

---

## Priority fix list — highest defence value per hour

If you fix nothing else, fix these. Each converts a "this is fake" into a "this is scoped."

| # | Fix | Effort | Converts |
|---|---|---|---|
| 1 | **Re-label all Web3 UI copy** — "Mainnet"→"local audit ledger", "self-custodied"→"server-held", "Verified Marketplace"→"P2P", "decentralized jury"→"staked-holder panel" | 5 min | 10 liabilities → honest scoping |
| 2 | **Add crisis detection to `chat.js`** — reuse `severity.js`'s phrase list; add eating-disorder + overdose terms; return DOH 1550 / NCMH 1553 | 1 h | The only finding with an immediate real-world harm path |
| 3 | **Delete the fabricated lab/certification seed data** — replace with `Demo Lab`, `SAMPLE` | 20 min | Removes what looks like fraud |
| 4 | **Hash `txs[].data` into the header hash** | 3 lines | Turns the biggest credibility gap into a real property |
| 5 | **Fix the `dedupe` key** in `supplement_detail.js` — include user id when personalised | 1 line | Closes a live cross-user health-data leak |
| 6 | **Add GitHub Actions**: `npm ci && npm test && npm run lint && npm run build` | 40 min | Fixes self-reported finding I3 |
| 7 | **Add `NODE_ENV=production` to the start script** + delete the `req.hostname` dev branch | 15 min | Re-enables 4 dead production guards |
| 8 | **Purge `inferEvidence` of fabricated PMIDs**; replace `:1188` with "no verified source available" | 2 h | Every one is currently a lie shown with a ✅ |
| 9 | **Make `MfaTransaction.attempts` real** — `$inc` on every second-factor failure; tighten the test to assert `peeked.attempts` | 45 min | Fixes a documented-but-false control |
| 10 | **Encrypt `AdminAccount.totpSecret`** through the existing `secretBox` | 1 h | The design exists; it was just never applied |
| 11 | **Add a DB readiness probe** — 503 when `readyState !== 1`; add `SIGTERM` handler | 45 min | `/api/health` currently lies |
| 12 | **Surface `engine: 'llm' \| 'rules'`** in the API response and UI | 1 h | Users can tell what produced their plan |
| 13 | **Add a query-string token ban note / stream ticket**; cap SSE connections | 2 h | Closes a documented self-contradiction |
| 14 | **Add `capstoneJudges`.md` listing the open limitations by name** | 1 h | Turns this entire document into a strength |

---

## The ten hardest questions — and the honest answers

| Question | Answer | Where it breaks |
|---|---|---|
| **"Is this a blockchain?"** | No. SHA-256 hash-chained append-only log in MongoDB, one process. | `docs/DEVELOPER_MANUAL.md:14-18` says so out loud |
| **"Show me consensus."** | There is none — `ledger.js:199-221` is a mutex. | |
| **"What stops an admin rewriting history?"** | Editing `txs[].data` succeeds silently. Deleting the tip succeeds silently. Editing a `txHash` requires re-mining every later block — but the auditor is in the same database. | |
| **"Show me a citation from your app and I'll click it."** | 15 of 20 point at unrelated papers. | 2.1 |
| **"Your backend is down. What does the user see?"** | A fully-formed, PMID-cited clinical plan with no marker it came from a hardcoded table. | 2.4 |
| **"Can someone capture the DAO?"** | Yes, with one new account. Welcome bonus 100 > quorum 50. | 1.5 |
| **"What does one WELL cost?"** | Nothing can tell you. The $0.12 index is decorative; there's no payment rail. | |
| **"How does a user buy a subscription?"** | They transfer money to a bank account and upload a screenshot. | 5.1 |
| **"What is your Wellness Score validated against?"** | Nothing. `15 + 0.5×adherence + 0.67×streak`, first term LLM-generated. | 2.8 |
| **"How do I get my data out / delete it?"** | Ask an admin. No export, no self-service delete. | |

---

## What is genuinely strong — say these out loud

A panel that hears only criticism will assume you didn't understand your own system. These are real:

**Security engineering**
- Argon2id at the OWASP interactive profile with transparent bcrypt→argon2 upgrade.
- `secretBox.js` — authenticated encryption with a **key-fingerprint envelope** and real rotation
  support. Better than most production implementations.
- The `MfaTransaction` state machine replacing "second factor + guessable user id."
- `middleware/stepUp.js` — `purpose` + `sid` + `id` + algorithms + 5-min TTL, transported in a header,
  never a URL. Correct and under-documented.
- `utils/origins.js` — a genuinely good CORS+CSRF pair with a **boot-time production guard.**
- `utils/floodGuard.js` — pre-parse metering, in-flight budget, and a **measured** grace period so
  refusals are actually deliverable. The RST-vs-FIN socket analysis with numbers is excellent
  engineering writing.
- The security activity log with a **closed `meta` vocabulary** so a secret structurally cannot be
  smuggled in — plus an honest post-mortem of the bug that had silently killed it.
- `testDbGuard.js` — born from two real production-database deletions.
- Self-attack tooling: `glitch-hunt.js` (120 probes), `glitch-hunt-web3.js` (21 sections, 132 probes).

**Correctness**
- Conditional atomic updates on every money path in `engine.js` — `debit`, `stake`, `unstake`,
  `accrueStake` all use `findOneAndUpdate({..., balance: {$gte: value}})`. Someone thought about
  double-spend.
- Exactly-once compare-and-swap on both admin approval queues, with claim release on failure.
- A global error handler that **never leaks stack traces**, plus log throttling for attacker-shaped
  4xx floods.
- 404-not-403 for ownership, applied consistently across every scoped route.
- `BackupCode` rejection sampling — 49 bits, no modulo bias, with the measured bias commentary.
- Schema-derived delete cascade — a new user-owned collection is erased without a code edit.

**Product & UX**
- Entitlement gating enforced **server-side**, with plan-card bullets **derived from the gates**
  rather than hand-written — and a written history of the fabricated claims it replaced.
- `pdfExport` (client-rendered, no server endpoint) correctly routed through a server gate.
- Real code splitting; a real ErrorBoundary with stale-chunk self-heal.
- `useScrolledPast.js` reads scroll position once per crossing, not per frame.

**Documentation**
- `SECURITY_AUDIT_REPORT.md` opens with an explicit honesty statement: *"This report does not claim
  SuppliWise is secure… Several Critical findings are only sanitized in the working tree — the
  underlying credentials live forever in public git history and must be rotated by a human."*
- `docs/DEVELOPER_MANUAL.md:14-18` says "simulated proof-of-work chain, no external chain, no gas,
  no wallets to fund" **in the product documentation.**
- `priorityFlagging.js` documents its own invariant: *"The safe direction to be wrong in is flag too
  much."*

**One more, because it's the best framing available:** `RRL_COMPLIANCE_IMPLEMENTED.md` is a written
compliance claim with a written verification procedure attached — **and the procedure was never run.**
The gap between "we said we'd check" and "we didn't check" is the sharpest teaching moment in this
entire codebase.

---

*Generated by static analysis of `server/` (Node/Express + MongoDB) and `my-react-app/` (React +
Vite + Capacitor). No files were modified in producing this document.*