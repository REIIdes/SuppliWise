# SuppliWise Blockchain Features — User Manual

> **Scope:** this manual covers the **blockchain / Web3 system** — wallet, WELL rewards,
> achievements, staking, marketplace & escrow, disputes, loyalty, data sovereignty, health
> ledger, governance, trials, oracles, expert consultations and product verification.
> For the rest of the application see `docs/USER_GUIDE.md`; for the technical side see
> `docs/DEVELOPER_MANUAL.md`.

Everything in this guide works on a normal SuppliWise account. You do **not** need to
understand blockchain — you just earn WELL, spend it, and get verifiable proof.

- **No account needed** to verify a product or open a shared health profile.
- **An account is needed** for wallets, rewards, the marketplace, governance and data sharing.
- Administrators cannot use these features (they have no health profile or wallet).

---

## 1. Your wallet and DID (your identity on the platform)

**Where:** *Web3* → **Wallet** panel (route `/web3`).

The first time you open it, SuppliWise creates your wallet automatically and credits a
**100 WELL welcome bonus**. You will see:

- a **DID** (`did:suppliwise:…`) — your decentralised identifier,
- an **address** (`0x…`) — your public account on the SuppliWise chain,
- your **WELL balance** and, if you stake, your **staked** amount,
- an **ed25519 public key** used to sign your health credentials.

### Exporting your private key

*Wallet* → **Export private key**. You receive a standard **PKCS#8 PEM** key
(`-----BEGIN PRIVATE KEY----- …`). Anyone holding this key controls your wallet.

> **Warning:** store it offline (password manager, hardware wallet, printed copy). Never
> paste it into a website, a chat, or a screenshot. SuppliWise re-encrypts it at rest and
> only decrypts it for you, but the export is final.

---

## 2. Earning WELL

### Daily check-in
**Where:** *Web3* → **Rewards**.

One tap per day. Your reward grows with your streak (base 5 WELL + 1 per consecutive day,
capped at 10 extra). A second tap the same day returns **“already claimed”** and mints
nothing — you cannot double-dip by refreshing.

### Intake reward
If you mark at least one supplement as **taken** in the intake tracker today, the Rewards
panel unlocks the **intake reward** (5 WELL). The server checks the real intake record, so
the button stays locked until you have actually logged a dose.

### Assessment reward
Complete an AI assessment and claim its reward (15 WELL) once. Replaying the same
assessment is rejected automatically.

### Data‑sharing reward
Share anonymised data with a research institution and earn **25 WELL** (see §7).

### Health‑ledger anchor
Anchor your health ledger snapshot for **3 WELL** (once per day).

### Knowledge base
Publish a post (**10 WELL**); each upvote earns you **2 WELL** (capped at 40 total) and pays
the person who upvoted **1 WELL** (see §9).

### Loyalty burn
Convert WELL into a discount code (see §8).

### Viewing your history
*Rewards* → **History** lists every reward with the exact block/transaction that recorded
it. Every row links to the chain explorer.

---

## 3. Achievements (NFTs)

**Where:** *Web3* → **Rewards** → *Achievements*.

Milestones are detected from your real activity — first assessment, 7‑day streak, data
pioneer, governor, market participant, trailblazer, verified professional, and more. Press
**Check achievements**; anything you now qualify for is minted as a collectible with a
token id, edition number and an on‑chain mint record.

Achievements are **soulbound**: they can be earned once and never re‑minted, and pressing
the button again simply mints nothing.

---

## 4. Staking WELL for premium

**Where:** *Web3* → **Rewards** → *Staking*.

- **Stake** moves WELL from your spendable balance into your staked balance.
- **Unstake** returns it (any amount, any time).
- Staked WELL earns a **12% APY**, credited automatically the next time your wallet is
  used, pro‑rated for the time elapsed.
- Reaching the DAO threshold (**500 WELL staked**) unlocks premium perks — the progress bar
  shows how close you are.

Staked WELL also increases your **DAO voting weight**.

---

## 5. Verify a product (public — no account)

**Where:** any product page, or the bottle itself: `/verify`.

1. Scan the **QR code** on the bottle (it opens `/verify/SW-XXXXXXXX`), or type the printed
   code into the search box.
2. You get a verdict:
   - **✅ VERIFIED** — the journey is anchored and every proof re‑checked.
   - **⚠ NOT VERIFIED** — the code is unknown, or the chain proof could not be confirmed.
     **Do not trust the product.**
3. The page shows the full journey (raw material → manufacturing → lab testing → quality
   release → distribution → retail → delivered), each step's location, who recorded it, and
   its block number — plus every certification (lab report, organic, non‑GMO, GMP…) with the
   digest of the result document.

Everything on this page is recomputed from the chain when you open it, so it is evidence,
not marketing copy.

---

## 6. Marketplace, escrow and disputes

**Where:** *Marketplace* (`/marketplace`).

### Selling
Create a listing (title, brand, category, price in WELL, stock). Your listing is anchored
on‑chain. The first six demo products are sold by the official SuppliWise brand wallet, so
you can try buying without selling.

### Buying (escrow protection)
1. Choose a product and quantity → **Place order**.
2. Your WELL moves into the **escrow wallet** — the seller cannot touch it yet.
3. When the product arrives → **Confirm delivery**. The contract executes: the seller is
   paid minus the 3% protocol fee (shown on the order), which goes to the treasury.

### If something is wrong
1. Open the order → **Open dispute** and describe the problem (at least 10 characters).
2. Independent **jurors** — staked WELL holders who are not part of the order — review the
   case and vote.
3. Outcome:
   - **Buyer wins** → you are refunded in full and the stock is returned.
   - **Seller wins** → the escrow is released to the seller.
   - **Tie** → nothing is paid out until there is a clear verdict.
4. Jurors are paid for their service, and their votes are weighted by their stake.

You can never vote on your own dispute, and both buyer and seller are excluded from the
jury.

### Loyalty codes
*Rewards* → **Loyalty** → redeem 10+ WELL for a one‑time code. Apply it at checkout to
reduce the order total. Codes are single use; a used code is rejected.

---

## 7. Your data, your call (privacy and sovereignty)

**Where:** *Web3* → **Data** panel.

### Health ledger
A running **digest** (fingerprint) of your assessments and intake history, plus snapshots
anchored to the chain. The chain stores the digest and counts — **never your health data**.

### Verifiable export
Export a **signed health credential** you can hand to a doctor or nutritionist. It carries a
digital signature, so the recipient can confirm it came from you and was not altered.

### Share your profile (public link)
Generate a **time‑boxed link** (1 hour to 30 days) that opens a read‑only doctor view of
your summary — no account needed on their side. You can revoke a link at any moment; it
stops working immediately. The view shows a disclaimer that it is not a diagnosis.

### Share anonymised data for research (earn 25 WELL)
Name a research institution and pick a scope. SuppliWise builds the dataset **on the
server** — coarse bands only (age band, gender, volume bands), never your name, exact dates
or free text — encrypts it, stores it under a content address, and anchors your consent.
You can **revoke** at any time: the consent is anchored as revoked **and the stored dataset
is destroyed**, so it can no longer be retrieved.

### Encrypted storage
Store any JSON payload (notes, records, exports) encrypted with AES‑256‑GCM under a
`bafy…` content id. Fetching it re‑checks the content id, so tampering is detectable.
Revoking a data share destroys only that dataset — your other stored items are untouched.

---

## 8. Verifiable AI recommendations

**Where:** *Web3* → *Records* (or the results of an assessment).

Anchor an assessment to record **what the AI was given, what it produced, and which logic
version produced it**. Later, re‑verify: SuppliWise recomputes both digests from the stored
record. If the inputs or outputs changed after the fact, verification fails and you can see
it. This is how you know a recommendation hasn't been quietly edited.

---

## 9. Community knowledge base and DAO governance

**Where:** *Governance* (`/governance`).

### Knowledge
Publish a **review**, **research** summary or **story**; earn WELL immediately. Other members
can upvote (they earn a small curator reward; you earn more, up to a cap). You cannot upvote
your own post, and nobody can upvote twice.

### Governance
Any proposal can change the platform's economic parameters — daily check‑in reward,
marketplace fee, staking APY, quorum, and more.

1. **Create a proposal** with a title, description and (optionally) the parameter to change.
   Your proposal vote is cast automatically with your weight (`balance + staked`).
2. **Vote** *for* or *against* on other proposals — one vote per wallet, weighted by your
   holdings at the time you vote.
3. A proposal **passes** when total voting weight reaches the quorum **and** FOR strictly
   outweighs AGAINST. Ties fail.
4. When the voting period ends, the outcome is finalised automatically and a passed
   proposal **actually changes the platform's settings**, with the execution recorded on the
   chain.

---

## 10. Clinical trials, oracles and expert consultations

**Where:** *Web3* → **Ecosystem**.

### Clinical trials
Browse open studies. Opting in hashes the exact terms — sponsor, data scope, revocability,
reward — and anchors them on‑chain, then pays the participation reward. **You can withdraw
at any time**, and the withdrawal is anchored too. One consent per trial.

### Oracle feeds
Live reference feeds for supplement prices, a WELL index and research signals, re‑derived
each day and anchored whenever a value changes. The same values are shown next to marketplace
listings, so you can sanity‑check a seller's price.

### Expert consultations
Four verified professionals (clinical nutrition, functional medicine, sports nutrition,
micronutrient research). Booking pays `rate × hours` in WELL into the professional pool, and
the booking is recorded on‑chain. Changed your mind? Cancel for a full refund.

---

## 11. Chain explorer

**Where:** *Web3* → *Chain*.

Every action above — reward, transfer, consent, certification, vote, order settlement — is
anchored as a transaction in a proof‑of‑work chain. The explorer shows recent blocks, the
tip, current difficulty and lets you look up any transaction by hash. **Verify chain**
recomputes every block hash from scratch and reports whether the history is intact.

---

## 12. Frequently asked questions

**Do I need a wallet app?** No. Your wallet is created and managed for you inside SuppliWise.
You only need the export if you want to move it elsewhere.

**Can I lose WELL?** Only by spending it — marketplace orders, loyalty burns and expert
bookings move it on‑chain, and escrow orders can be refunded. There is no transfer to a
third party that you cannot see in your history.

**Is my health data on the blockchain?** No. Only sha256 digests and counts are anchored.
Your records stay in the application database, and datasets you share for research are
coarse, encrypted and revocable.

**What if two people click the same reward button twice?** The database enforces one reward
per activity (`user + kind + reference`), so a second attempt is rejected — not paid twice.

**Why did a dispute not resolve instantly?** Verdicts need every appointed juror to vote (or
a single clear verdict in an open jury). Ties deliberately pay nobody.

**Can an administrator use my data?** The blockchain features are limited to user accounts.
Administrators are rejected by the API, and every share link and consent is revocable by you.

**Something looks wrong — what do I do?**
1. Check the chain explorer → **Verify chain** (history intact?).
2. Check the public verify page for the product code.
3. Revoke any share link or data consent you no longer want.
4. Report it in the community knowledge base or a governance proposal.
