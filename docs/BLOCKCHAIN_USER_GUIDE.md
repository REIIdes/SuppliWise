# SuppliWise Blockchain Features — Step-by-Step User Guide

**For members using SuppliWise. No technical knowledge needed.**

If you just want to know *what the blockchain part does for you*, read
[Part 1](#part-1--what-this-is-for-in-plain-english). It is about four minutes.

If you want the full walkthrough of every feature, in order, continue to
[Part 2](#part-2--step-by-step-walkthrough).

---

## Contents

**Part 1 — What this is for, in plain English**
1. [What the blockchain layer actually is](#1-what-the-blockchain-layer-actually-is)
2. [Your WELL tokens](#2-your-well-tokens)
3. [Your wallet and decentralized ID](#3-your-wallet-and-decentralized-id)
4. [What is and isn't written to the chain](#4-what-is-and-isnt-written-to-the-chain)

**Part 2 — Step-by-step walkthrough**
5. [Getting started: unlock the blockchain layer](#5-getting-started-unlock-the-blockchain-layer)
6. [Step 1 — Set up your wallet](#6-step-1--set-up-your-wallet)
7. [Step 2 — Earn WELL: daily check-ins and streaks](#7-step-2--earn-well-daily-check-ins-and-streaks)
8. [Step 3 — Claim achievement badges](#8-step-3--claim-achievement-badges)
9. [Step 4 — Stake WELL for rewards](#9-step-4--stake-well-for-rewards)
10. [Step 5 — Use the marketplace and escrow](#10-step-5--use-the-marketplace-and-escrow)
11. [Step 6 — Verify a product's journey](#11-step-6--verify-a-products-journey)
12. [Step 7 — Participate in governance](#12-step-7--participate-in-governance)
13. [Step 8 — Control your health data](#13-step-8--control-your-health-data)
14. [Step 9 — Prove an AI recommendation](#14-step-9--prove-an-ai-recommendation)
15. [Step 10 — Loyalty codes and clinical trials](#15-step-10--loyalty-codes-and-clinical-trials)
16. [Step 11 — Explore the chain yourself](#16-step-11--explore-the-chain-yourself)

**Part 3 — Integrity: how tamper-evidence works**
17. [How the chain proves nothing was changed](#17-how-the-chain-proves-nothing-was-changed)
18. [What happens if the chain is ever tampered with](#18-what-happens-if-the-chain-is-ever-tampered-with)
19. [Reading a transaction yourself](#19-reading-a-transaction-yourself)

**Part 4 — Reference**
20. [Glossary](#20-glossary)
21. [Troubleshooting](#21-troubleshooting)
22. [Frequently asked questions](#22-frequently-asked-questions)

---

# Part 1 — What this is for, in plain English

## 1. What the blockchain layer actually is

SuppliWise keeps two things side by side:

| | What it is | What it does |
|---|---|---|
| **Your account data** | A normal secure database | Holds your health records, orders, wallet balance. This is the real, authoritative copy. |
| **The SuppliWise chain** | An append-only public ledger | A tamper-evident log of *digests* (fingerprints) of everything important that happened. |

The critical thing to understand:

> **Your database is the source of truth. The chain is the tamper-evident receipt.**

That ordering is deliberate, and it is why the blockchain layer can never block
your account from working. If the chain were unavailable, your balance and your
orders would still be exactly right — you'd just lose the extra proof. The
reverse is not true: if the chain is broken, that is a serious alarm, and we
tell you.

**What this buys you.** The chain lets you independently answer "did this really
happen, and has anything been quietly edited since?" — for your rewards, your
marketplace orders, your product's supply chain, and your data-consent
decisions. That answer is one no single employee, no database administrator and
no compromised login can quietly change.

**What it does not do.** There is no real cryptocurrency here. WELL is a
points-style token used only inside SuppliWise. There is no external
blockchain network, no gas fees, no wallet you fund with real money, and no way
to cash WELL out. It is an in-app, self-hosted proof-of-work ledger.

## 2. Your WELL tokens

WELL is the in-app token used across the whole blockchain layer. You get it for
healthy behaviour, and you spend it on marketplace purchases, expert
consultations and loyalty rewards.

**Ways to earn WELL:**

| Action | Reward |
|---|---|
| Create your wallet (once) | 100 WELL welcome bonus |
| Daily healthy check-in | 5 WELL, +1 per consecutive day, up to +10 |
| Complete an AI assessment | 15 WELL |
| Track intake on a new day | 5 WELL |
| Publish to the knowledge base | 10 WELL |
| Receive an upvote on your post | 2 WELL (capped at 40) |
| Upvote an accepted post | 1 WELL |
| Grant a data share | 25 WELL |
| Serve on a marketplace jury | 5 WELL |
| Anchor a health snapshot | 3 WELL |

**Ways to spend WELL:**

- Buying supplements in the marketplace
- Booking a verified professional consultation
- Converting WELL into a loyalty discount code

Every earning and spending action is written to the chain as a transaction with
your wallet address as the actor.

## 3. Your wallet and decentralized ID

When you first open the Web3 area, SuppliWise generates a real cryptographic
identity for you: an **ed25519 keypair**.

- The **public key** is your identity — it is public and safe to share.
- The **private key** is what proves it is you.
- Your **address** is derived from the public key: a `0x…` string that looks
  like a blockchain address.

Your key is generated on the server, encrypted with AES-256-GCM before storage,
and never transmitted anywhere. You can export it as a standard PEM file if you
want to sign something outside SuppliWise, but you do not need to.

> **You never need to write down or remember a seed phrase.** There isn't one.
> If you lose access to your account you recover it the normal way, and your
> wallet comes back with it. If you *export* the private key and lose it, nobody
> — including us — can recover it.

## 4. What is and isn't written to the chain

This is the part most people worry about, so here it is plainly.

**Never written to the chain:**

- Your name, email, or any account identifier
- Your health assessments, symptoms, conditions, or medications
- Your intake logs
- Any personal data whatsoever
- Anything a scanner could read

**Written to the chain:**

- A transaction type (`reward:checkin`, `market:order`, `stake`, …)
- Your wallet address (a public hash, not your identity)
- A **SHA-256 digest** of the payload — a one-way fingerprint
- Public, non-personal metadata: amounts, step names, product codes

A digest is one-way. Given a digest, nobody can reconstruct your data — not us,
not anyone. So the chain proves *that* a record exists and *that* it hasn't
changed, without revealing *what* the record says.

> The chain shows amounts and actions. It never shows your health data.

---

# Part 2 — Step-by-step walkthrough

## 5. Getting started: unlock the blockchain layer

The entire blockchain layer requires the **DELUXE plan** (or above).

**To open it:**

1. Sign in to SuppliWise.
2. Go to your profile and select the plan.
3. If you're on FREE, you'll see an upgrade card on any Web3 screen. Upgrade to
   DELUXE (or higher) to unlock everything in this guide.
4. Navigate to the blockchain area from the main navigation.

If a screen shows you an upgrade card instead of content, that's the plan gate
working correctly — not a bug. Every blockchain screen reports exactly which
plan it needs.

## 6. Step 1 — Set up your wallet

**To create your wallet:**

1. Open the blockchain area and go to **Wallet**.
2. On first visit, your wallet is created automatically. There's nothing to fill
   in — no seed phrase, no password, no separate signup.
3. You'll see:
   - **Your DID** — a decentralized identifier, e.g. `did:suppliwise:<id>`
   - **Your address** — a `0x…` string
   - **Your balance** — should show **100 WELL** from the welcome bonus

**To see your balance:**

The balance updates on every visit. Each page load also advances any staking
rewards you've earned, so the number you see is current.

**To export your signing key (optional):**

1. In **Wallet**, select **Export private key**.
2. The key downloads as a `.pem` file.
3. Store it offline, somewhere encrypted.

> ⚠️ **Anyone holding this key controls your wallet.** Exporting is recorded on
> your account so there's an audit trail. You don't need this for normal use.

**What each number means:**

| Field | Meaning |
|---|---|
| Balance | WELL you can spend right now |
| Staked | WELL locked to earn rewards (see Step 4) |
| Earned total | Lifetime WELL earned |
| Spent total | Lifetime WELL spent |

## 7. Step 2 — Earn WELL: daily check-ins and streaks

A check-in records that you engaged with your health today.

**To check in:**

1. Open the blockchain area → **Rewards**.
2. Select **Check in for today**.
3. If today is new, you receive the reward immediately. Your streak grows.

**How the streak reward works:**

- Day 1: 5 WELL
- Day 2: 6 WELL
- Day 3: 7 WELL
- …capped at 15 WELL (10 streak steps)

**Streak rules:**

- A streak survives if you check in today, or if you checked in yesterday and
  haven't checked in today yet.
- Miss a full day and the streak resets to zero.

**Other rewards you'll earn automatically:**

Complete an AI assessment → 15 WELL. Track intake on a new day → 5 WELL. Both
are credited automatically; you don't claim them by hand.

**To see your history:**

The **Rewards** screen lists every reward event with its date, amount, and the
on-chain transaction hash. That hash is your receipt — see
[Part 3](#part-3--integrity-how-tamper-evidence-works) for how to check it.

## 8. Step 3 — Claim achievement badges

Achievement badges are non-transferable certificates recorded on-chain when you
reach a milestone. You keep them for the account's lifetime — they can't be
sold or moved.

**To check your badges:**

1. Open **Rewards → Achievements**.
2. Eligible badges are shown, including what each requires.

**To claim them:**

1. Select **Check achievements**.
2. Every badge you've earned is minted and anchored on-chain.

**The full list:**

| Badge | Requirement |
|---|---|
| First Steps | Complete 1 assessment |
| 7-Day Streak | 7 consecutive check-in days |
| 30-Day Streak | 30 consecutive check-in days |
| 365-Day Streak | 365 consecutive check-in days |
| Wellness Scholar | 10 assessments |
| Data Pioneer | Share anonymized data with researchers |
| Governor | Cast a vote in governance |
| Market Participant | Complete a verified marketplace order |
| Diamond Hands | Stake 500 WELL or more |
| Trailblazer | Opt in to a clinical trial |
| Verified Professional | Book an expert consultation |

Eligibility is computed from your **real activity** on the server — you can't
claim a badge you haven't earned. Each badge is minted once and only once.

## 9. Step 4 — Stake WELL for rewards

Staking locks WELL in your wallet so it earns a return. Locked WELL can't be
spent; your free balance can.

**To stake:**

1. Open **Rewards → Staking**.
2. Enter an amount (or select a preset).
3. Select **Stake**.

Your staked amount moves from `Balance` to `Staked`. Your progress toward
premium perks is shown as a bar.

**How the reward works:**

- Staked WELL earns a **12% annual yield**, accrued daily.
- Accrual is time-based: the longer your WELL stays staked, the more you earn.
- Rewards are added to your free balance automatically when you next use the
  wallet.
- Accrual only happens on activity — there's no background job crediting you at
  3am. Open the wallet and it catches up.

**To unstake:**

1. Open **Rewards → Staking**.
2. Enter the amount to release.
3. Select **Unstake**.

The WELL returns to your free balance immediately.

> Staked WELL also makes you eligible to serve as a marketplace juror, which
> earns WELL. See [Step 5](#10-step-5--use-the-marketplace-and-escrow).

## 10. Step 5 — Use the marketplace and escrow

The marketplace lets you buy and sell supplements using WELL. Funds are held in
**escrow** — they only move when the order completes or a dispute resolves.

### 10a. Buying a product

1. Open **Marketplace → Listings**.
2. Browse available products, with price in WELL and stock remaining.
3. Select **Buy**.
4. Choose quantity, and optionally enter a loyalty discount code.
5. Confirm.

**What happens:**

- WELL moves from your wallet into **escrow** (it is held, not given to the
  seller yet).
- Stock is reserved.
- Your order shows status **In escrow**.

### 10b. Escrow release

**As the buyer — confirm you received the goods:**

1. Open **Marketplace → My orders**.
2. Find the order.
3. Select **Confirm delivery**.

The escrowed WELL is released: the seller receives the amount minus the 3%
protocol fee, and the fee goes to the protocol treasury. Your order becomes
**Completed**.

> You can only confirm your *own* order, and only once. A second confirmation
> changes nothing.

### 10c. Selling a product

1. Open **Marketplace → Sell**.
2. Create a listing: title, brand, category, price in WELL, stock.
3. Your listing goes live and buyers can purchase it.

**When someone buys:** stock decreases, their WELL goes to escrow, and you're
paid when they confirm delivery or a dispute resolves in your favour.

### 10d. Disputes

If something goes wrong, you can open a dispute instead of confirming.

1. Open **Marketplace → My orders**.
2. Find the order.
3. Select **Report a problem**.
4. Describe what happened.

**How disputes work:**

- Only the buyer or the seller can open a dispute.
- A panel of **staked token holders** who are not parties to the order is
  appointed. These are the jurors.
- Jurors vote **buyer** or **seller**.
- The verdict settles once a clear majority of the panel has voted.
- **If you win:** your escrowed WELL is refunded in full.
- **If the seller wins:** they're paid the proceeds.
- **If jurors tie:** nothing is paid out and the dispute stays open. Funds remain
  safely in escrow. No verdict, no payout.

Jurors earn WELL for serving. They cannot be a party to the order they judge.

## 11. Step 6 — Verify a product's journey

Every product batch has a supply-chain record showing where it came from. This
is the most tangible use of the chain, and **you can check it without an
account**.

### 11a. Scanning a bottle

1. Find the QR code on the product.
2. Scan it with your phone camera.
3. The verification page opens. **No sign-in required.**

You'll see:

- The product name and brand
- Every step of its journey, in order, with location and date:
  `Raw sourcing → Manufacturing → Lab testing → Quality release → Distribution
  → Retail → Delivered`
- Any certifications, with their issuer

### 11b. What "verified" means

The page shows a **proof** panel. This is the important part.

The page doesn't just *display* the journey — it **re-checks the underlying
blockchain record**. For every step, it re-derives the transaction's hash, the
payload's fingerprint, and the block's own hash, and compares them to what's
stored. If any of it was edited, the page says so.

**What each verdict means:**

| Verdict | Meaning |
|---|---|
| **Verified** | Every anchored record re-checked and matched. Nothing was altered. |
| **Not verified** | At least one record failed. The batch details are shown, but don't rely on them. |

> ⚠️ If you ever see **Not verified** on a product, please report it. It means
> the record was altered after the fact, which should never happen.

**Note on demo data.** The SuppliWise-branded sample batches in a fresh install
are **demonstration records**. They show how the feature works; they are not
certifications issued by the named third-party laboratories. Treat those specific
batches as product demos rather than as lab attestations.

## 12. Step 7 — Participate in governance

Some platform rules are decided by the community, not by us. Voting uses WELL
as voting weight.

**What's governed:**

- Daily check-in reward amount
- Staking APY and the premium threshold
- Marketplace fee percentage
- Welcome bonus and reward values
- Voting window length and quorum

**To vote:**

1. Open **DAO → Proposals**.
2. Select an active proposal.
3. Choose **Vote for** or **Vote against**.
4. Confirm.

**How a proposal passes:**

All four must hold:

1. The voting window hasn't closed.
2. Enough total voting weight participated (**quorum**, currently 50).
3. "For" weight strictly exceeds "Against" weight.
4. Each wallet gets exactly **one** vote, weighted by the WELL it held (plus
   staked) at the moment it voted.

If passed, the new parameter value is applied automatically and the change is
anchored on-chain. You'll see who set it and when.

**Your voting weight** is your free balance plus your staked balance.

## 13. Step 8 — Control your health data

You decide what leaves your account and to whom. Every decision is recorded on-chain.

### 13a. Share anonymized data

1. Open **Data sovereignty → Shares**.
2. Select **Create a data share**.
3. Choose a **scope**:
   - *Nutrition outcomes* — how your habits correlated with results
   - *Adherence study* — whether you followed the plan
   - *General research* — broad anonymized participation
4. Name the recipient.
5. Confirm.

You earn 25 WELL. The record shows the scope, the recipient, and the date.

### 13b. Revoke a share

1. Find the share.
2. Select **Revoke**.
3. Confirm.

It becomes inactive immediately. The original record stays on-chain — you can't
erase history, only withdraw consent going forward. That transparency is the
point: it proves to a researcher exactly when consent started and ended.

### 13c. Encrypted storage

Store a private note on-chain-encrypted:

1. Open **Data sovereignty → Storage**.
2. Paste or enter your content.
3. Select **Pin**.

It is encrypted with a key only you hold, then content-addressed. The address is
derived from the encrypted bytes, so it changes if the content changes. Nobody
else can read it.

**Size limit:** about 900 KB per item. This is for notes, not backups.

## 14. Step 9 — Prove an AI recommendation

This is the most technical feature and the least commonly needed. It lets you
prove an AI recommendation came from the model that produced it — and that the
model's logic hasn't changed since.

**To anchor a recommendation:**

1. Complete an assessment.
2. Open **AI proof**.
3. Select **Anchor this recommendation**.

Recorded on-chain: a hash of your inputs, a hash of the output, and which logic
version produced it.

**What it proves:** if the recommendation text ever changed without the model
version changing, the hashes would no longer match.

**What it doesn't prove:** it doesn't make the recommendation *correct*. AI
recommendations are informational, not medical advice. A verified hash means
"this is exactly what the system produced" — not "this is right for you."

## 15. Step 10 — Loyalty codes and clinical trials

### 15a. Loyalty codes

Convert WELL into a discount code you can apply to a marketplace order.

1. Open **Rewards → Loyalty**.
2. Enter an amount of WELL (minimum 10, or whatever the current rate requires).
3. Select **Redeem**.

You get a unique code. Enter it at checkout on your next order.

**Rules:**

- One code discounts one order.
- Each code can be redeemed exactly once.
- The discount can't exceed your order total.

### 15b. Clinical trials

Browse studies you can join.

1. Open **Trials**.
2. Select a study to read its full description.
3. Select **Opt in** if you agree.
4. Confirm.

Your consent — scope, date, terms fingerprint — is recorded on-chain. Trials pay WELL for participation.

**To withdraw:** open the trial and select **Withdraw**. Your consent record stays visible on-chain showing you withdrew, and when. That's deliberate: it proves to researchers exactly when consent ended.

## 16. Step 11 — Explore the chain yourself

The chain explorer lets you look at blocks and transactions directly.

**To see recent blocks:**

1. Open the **Chain** screen.

You'll see each block's number, timestamp, transaction count, hash, and the hash
of the block before it.

### What a block is

Every time something is recorded, it goes into a **block** — a batch of
transactions. Each block contains:

| Field | What it means |
|---|---|
| Index | The block's position (its height) |
| Timestamp | When it was created |
| Previous hash | The hash of the block before it — **this is what chains blocks together** |
| Nonce | The number the proof-of-work search settled on |
| Hash | This block's own fingerprint |
| Difficulty | How hard the proof-of-work was |
| Transactions | The records inside it |

**Proof of work.** Before a block is accepted, the server searches for a number
(`nonce`) that makes the block's hash start with several zeros. Finding it
requires a small amount of real computation, so creating blocks costs a little
effort and can't be done instantly at scale.

**Why blocks are chained:** each block stores the previous block's hash. Change
anything in an old block and its hash changes — which breaks the link to the
next one, and every block after it. The break cascades forward, which is what
makes editing history detectable.

### Checking chain health yourself

Open the **Chain** screen. It shows:

- **Height** — the current number of blocks
- **Status** — healthy, verifying, or compromised
- **Last full verification** — when every block was last re-checked from scratch

You can also request a full re-verification on demand. On a large chain this
takes longer than an instant check, so normal checks only re-verify blocks
added since the last complete check.

---

# Part 3 — Integrity: how tamper-evidence works

## 17. How the chain proves nothing was changed

Four independent mechanisms work together.

### 17a. Payload fingerprints (SHA-256)

Every transaction stores a **digest** of its payload — a SHA-256 hash. Change
one character of the payload and you get a completely different digest.

The chain verifies that each stored payload still matches its recorded digest.
**Editing a stored record breaks this check immediately.**

### 17b. Chained block hashes

Each block stores the previous block's hash. Editing an old block changes *its*
hash, which no longer matches what the *next* block recorded — and that
mismatch propagates forward through every subsequent block.

### 17c. Commitment to the whole transaction

The block's hash covers each transaction in full: its type, actor, digest,
timestamp, **and payload**. Changing *any* part of *any* transaction changes the
block's hash.

### 17d. Proof of work

Each block's hash must start with several zeros (currently 3). Finding such a
hash requires genuine computation, so blocks can't be manufactured instantly at
scale.

### 17e. A sealed, high-water record

Two more protections handle attacks the hashes alone cannot:

**A sealed checkpoint.** The record of "everything up to block N has been
verified" is signed with a key held *outside* the database (derived from
`CHAIN_SEAL_KEY`, or from your server's `JWT_SECRET`). If someone edits that
record to claim a rewritten chain is verified, the signature won't match — so the
claim is discarded and the chain is re-hashed from the very beginning. **A
database credential on its own is not enough to fake a verification.**

**A host-filesystem anchor.** The deepest verified position is also recorded in
an append-only file on the server's disk. This catches the attack where an
attacker deletes recent blocks *and* deletes the database record of how far the
chain used to go. Deleting blocks requires database access; deleting the file on
the host requires a different kind of access entirely.

Together: **an attacker needs database write access AND host filesystem access
AND the sealing key to rewrite the chain undetectably.**

## 18. What happens if the chain is ever tampered with

If any check fails, this is the exact sequence.

### Step 1 — Detected immediately

The verification that catches it runs:

- Automatically on a schedule (a full re-hash every few minutes)
- On every blockchain screen you open
- Continuously by the admin security monitor
- On demand via a full re-verification

### Step 2 — Marked critical

The affected blockchain area shows a clear warning, and the admin security
monitor reports the failure as **critical**, naming the exact block where the
problem was found and what kind of failure it is:

| Failure type | What it means |
|---|---|
| Linkage or payload altered | History was modified after the fact |
| Truncation | Blocks are **missing** — restore from backup |
| Tip rewritten | The most recent block was replaced |

These need genuinely different responses, which is why the system distinguishes
them rather than reporting one generic failure.

### Step 3 — **You are notified automatically**

This is the part that matters most, and it previously didn't exist.

When a break is found, SuppliWise automatically sends a notification to:

- **Every account with blockchain activity** — through your normal notification
  bell
- **Every administrator** — through the admin alert stream

**What the notification says:**

> An automatic integrity check found a problem in SuppliWise's blockchain ledger
> at block N. Nothing has been deleted and your account is still safe, but records
> anchored around that block are temporarily not being treated as verified, and
> the ledger is under investigation. Your balances and order history are stored
> separately and are unaffected. This notice is sent automatically to every
> account with blockchain activity the moment a problem is detected. You do not
> need to do anything.

**What this means for you in practice:** you don't need to do anything, and you
don't need to have the app open to find out. If your records are affected, you
are told.

**When it's resolved**, the same audience receives a follow-up notice saying the
chain has been re-verified and is healthy again. An alarm you can never turn off
would train you to ignore alarms.

### Step 4 — The chain stops accepting new records

This is the most important thing to understand, because it affects what you see
in your account.

When a break is found, the ledger **quarantines itself**: it refuses to write any
new blocks until an engineer resolves it.

You might think that is drastic. It is the opposite. Before this behaviour
existed, the chain would report a problem and then **keep accepting new records
anyway** — piling fresh blocks on top of the damaged ones, so the problem got
buried deeper with every transaction, and every new receipt inherited the
defect. Freezing is what stops a bad situation from compounding.

**What this means for you in practice:**

| | During quarantine |
|---|---|
| Your balance, rewards, orders | **Unaffected.** These live in your account, not the chain. |
| Using the app normally | **Works exactly as usual.** |
| Earning rewards | **Still happens.** You are credited as normal. |
| The on-chain receipt (transaction hash) | **Temporarily withheld.** It appears once the chain is repaired. |

So if you complete a reward during this time and don't see a transaction hash
next to it, **nothing was lost.** Your reward is recorded on your account; only
the blockchain receipt is on hold. This is stated plainly in the notification you
receive, precisely so you don't have to guess.

### Step 5 — Repair

A hash chain cannot have a bad block corrected in place. Editing block N changes
its fingerprint, which breaks the link to block N+1, which breaks that one's
fingerprint, and so on to the very end. **There is no such thing as "fixing" a
block** — the only consistent chain is the part that was never damaged.

So repair means: **discard everything from the first damaged block onward, keep
everything before it, and carry on from there.**

That sounds drastic, so here is what it is *not*:

- ❌ **It is not a reset.** The chain keeps its original genesis block and all
  verified history before the problem. It does not start over.
- ❌ **It is not silent.** The discarded blocks are recorded permanently in a
  repair log, visible to administrators and readable afterwards.
- ❌ **It is not automatic.** A self-healing chain would let someone who damaged
  it simply wait for the system to tidy up after them. Repair is always a
  deliberate human decision.
- ❌ **It does not affect your account.** Balances, orders, rewards and history
  are untouched — only the blockchain proof is rebuilt.

**You will be told when it happens.** After a repair, everyone who received a
warning receives a follow-up notice explaining what was resolved, whether blocks
were discarded, and that their account was never at risk.

### Step 6 — Affected records are distrusted

Until the chain is healthy, digests from the affected block onward are not
treated as proof. This is the safe default: better to say "unverified" than to
confirm something that may be wrong.

### One case repair cannot fix

If blocks are **missing** rather than altered, discarding blocks cannot bring
them back — the missing blocks are the evidence. In that situation the correct
response is to **restore from a backup**, and the system says so rather than
letting anyone attempt a repair that cannot possibly work.

Your account data is safe in this case too, because it was never in the chain.

### Summary

| Question | Answer |
|---|---|
| Is it permanent? | **No.** An engineer repairs it. |
| Does it start a brand-new chain? | **No.** The same chain continues from the last verified block. |
| Do I lose my balance, rewards, or orders? | **No.** Those live in your account, not the chain. |
| Can I keep using the app? | **Yes.** Everything works; only on-chain receipts pause. |
| Will I be told what happened? | **Yes.** At the time, and again when it is resolved. |
| Could someone tamper and hide it? | No. Detection is automatic and alerting is automatic. |

### What we would do about it

| Failure | Response |
|---|---|
| Altered history | Full security investigation — indicates unauthorized database modification |
| Truncation (blocks missing) | Restore from backup; discarding blocks cannot recover missing ones |
| Broken integrity seal | Treat as a tamper attempt until proven otherwise |
| Structural damage | Repair to the last verified block, logged permanently |

## 19. Reading a transaction yourself

Every action that affects your account returns a **transaction hash** — a 64
character fingerprint. It's your receipt.

**To look one up:**

1. Find the transaction hash on your reward entry, order, or badge.
2. Open the **Chain** screen.
3. Select **Look up transaction**.
4. Paste the hash.

You'll see the transaction type, your wallet address, the amount, the timestamp,
and the containing block.

**To check a hash yourself** (optional, technical):

Any SHA-256 tool will confirm a transaction hash is derived from its content.
Given the same content it always produces the same hash — and changing anything
changes it completely. This is why a stored hash can't be quietly edited.

---

# Part 4 — Reference

## 20. Glossary

| Term | Meaning |
|---|---|
| **WELL** | The in-app token used for marketplace purchases, staking, voting weight, and loyalty rewards. Not real currency. |
| **Wallet** | Your account's cryptographic identity and WELL balance. |
| **DID** | Decentralized Identifier — your on-platform identity, e.g. `did:suppliwise:…` |
| **Address** | A `0x…` string derived from your public key. Your public identity on-chain. |
| **Public key** | Safe to share. Proves a transaction came from you. |
| **Private key** | Your secret. Anyone holding it controls your wallet. |
| **Block** | A batch of transactions, fingerprinted and chained to the previous one. |
| **Block hash** | The fingerprint of a block. Change anything inside and it changes. |
| **Previous hash** | The hash of the block before this one. This is what chains the ledger together. |
| **Nonce** | The number found during proof-of-work search. |
| **Difficulty** | How many leading zeros a block's hash must have. Higher = harder. Currently 3. |
| **Proof of work** | Requiring real computation before accepting a block. |
| **Height** | The number of the most recent block — how long the chain is. |
| **Transaction (tx)** | One recorded action: a reward, a purchase, a stake. |
| **Transaction hash** | A transaction's unique fingerprint, and your receipt for it. |
| **Digest** | A one-way SHA-256 fingerprint of data. Proves it hasn't changed; reveals nothing about content. |
| **Anchor** | Writing a record's digest to the chain. |
| **Escrow** | WELL held safely between buyer and seller until the order completes. |
| **Stake / Staked** | WELL locked in your wallet to earn a return. |
| **APY** | Annual Percentage Yield — the annual return on staked WELL. Currently 12%. |
| **Quorum** | Minimum total voting weight needed for a DAO vote to be valid. |
| **Juror** | A staked token holder who votes on marketplace disputes. |
| **Soulbound badge** | An achievement that belongs to your account permanently. It can't be sold or transferred. |
| **Tamper-evident** | Altered data can be *detected*. Not the same as unalterable. |
| **Fork** | Two different blocks claiming the same position — a split history. |

## 21. Troubleshooting

### "This feature requires the DELUXE plan"

The blockchain layer is a paid feature. Upgrade from your profile, then reopen
the screen. Every blockchain screen tells you exactly which plan it needs.

### "User account required"

Administrator accounts don't have wallets or health records. Use a regular
member account to use the blockchain layer.

### My balance is 0 and I never spent anything

Check **Staked**. If your WELL is staked, it's still yours — it just isn't
spendable. Unstake from **Rewards → Staking**.

### I checked in today but got nothing

Check-ins can only be claimed **once per day**, and the claim is enforced by the
system, so a double-click can't pay twice. If you've already claimed today,
you'll see that it was already claimed.

### My streak reset

Streaks require **consecutive** days. Missing a full day resets the count. A
streak survives if you check in today, or checked in yesterday and haven't yet
today.

### My staking rewards haven't appeared

Rewards accrue based on elapsed time and are applied when you next use the
wallet. There's no background job crediting them — open the wallet and they
catch up. The longer your WELL has been staked, the more you earn.

### A marketplace order is stuck in escrow

Escrow releases when you confirm delivery (as buyer) or when a dispute resolves.
Open **Marketplace → My orders** and either confirm or report a problem.

### My dispute hasn't resolved yet

A dispute settles once a clear majority of the appointed jury has voted. If
several jurors haven't voted yet, it's still open. If the jury ties, funds stay
in escrow and no payout occurs — a tie never resolves the dispute one way or
other.

### I lost my exported private key

Nobody can recover it, including us. Your account and wallet are still fine —
recovery is through normal account sign-in. The exported key only matters if you
were using it to sign something outside SuppliWise.

### I see a chain warning

See [What happens if the chain is tampered with](#18-what-happens-if-the-chain-is-ever-tampered-with).
Your account keeps working, and you'll have received a notification.

### I completed something and there's no transaction hash

Most often this is the chain being repaired. Everything you did was recorded on
your account — only the on-chain receipt is temporarily withheld. It will appear
once the chain is healthy again. You do not need to do anything, and you have not
lost anything.

If no chain warning has been shown, contact support.

### A product verification says "Not verified"

Please report it. It means the record was altered after the fact, which should
never happen.

## 22. Frequently asked questions

**Is my health data really not on the blockchain?**
Yes. Only SHA-256 digests — one-way fingerprints — are written. A digest cannot
be reversed into your data. Names, emails, assessments, symptoms, and intake
logs are never written to the chain.

**Can I get my data off the chain?**
There's nothing to get off — your data was never on it. It's in your account,
under your control, and you can request its deletion from your profile settings.

**Can someone change a record without me noticing?**
No. That's the entire point. The four mechanisms in
[Part 3](#17-how-the-chain-proves-nothing-was-changed) mean any change to any
record breaks a check, and the break is reported automatically to you and to
administrators.

**Could a SuppliWise employee quietly edit my history?**
Not without detection. Rewriting the chain requires database write access *and*
host filesystem access *and* the sealing key. The detection is automatic and
notices everyone involved, including you.

**If the chain breaks, do I lose everything?**
No. Your account, balance, orders and rewards are stored separately from the
blockchain and are never affected. What stops is only the *extra proof* that those
records haven't been altered.

**Will the chain start again from scratch?**
No. It continues as the same chain from the last block it could verify. The
original genesis block and all verified history are preserved.

**Who decides to repair it, and can they hide what they removed?**
Repair is a deliberate engineering decision requiring explicit confirmation — the
system can never do it by itself. Every discarded block is recorded permanently in
a repair log, and everyone affected receives a notification saying blocks were
discarded. There is no way to repair quietly.

**Is this a real cryptocurrency / can I cash out?**
No. WELL is an in-app token only. There's no external blockchain, no mining, no
gas fees, no real-money funding, and no cash-out path. It's a self-hosted
proof-of-work ledger for record integrity.

**What happens to my WELL if the chain breaks?**
Nothing. Your balance lives in your account database, not the chain. A chain
failure withholds the *proof*, not your funds or your access.

**Can I transfer WELL to another person?**
Not currently. There's no peer-to-peer transfer feature — WELL is spent within
SuppliWise on marketplace purchases, consultations, and loyalty rewards.

**Why does a check-in page load seem slow?**
Some actions do a small proof-of-work calculation before writing a block. This
is by design and usually imperceptible. Extremely busy periods may feel slightly
slower.

**Who decides the platform rules?**
Some of them, through DAO voting weighted by WELL. See
[Step 7](#12-step-7--participate-in-governance). Rules that affect safety or
billing aren't community-voted.

---

## Related documentation

| Document | For |
|---|---|
| [`USER_GUIDE.md`](../USER_GUIDE.md) | The complete SuppliWise user guide |
| [`docs/USER_MANUAL.md`](USER_MANUAL.md) | Full manual, all features |
| [`BLOCKCHAIN_FEATURES.md`](../BLOCKCHAIN_FEATURES.md) | Feature-to-code map for developers |
| [`WEB3_DEVELOPER_MANUAL.md`](../WEB3_DEVELOPER_MANUAL.md) | Technical deep dive |
| [`SECURITY.md`](../SECURITY.md) | Security practices and reporting |