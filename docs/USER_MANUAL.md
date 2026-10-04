# SuppliWise — User Manual

**Your personalised supplement advisor, with proof you can check.**

> Stop guessing. Start knowing what your body actually needs.

---

## About this manual

This is the complete guide to SuppliWise. It is written for two people:

| You are… | Start here |
|---|---|
| **New to SuppliWise** | [Part 1 — Getting started](#part-1--getting-started) |
| **Already using it, want the full feature list** | [Part 2 — The features](#part-2--the-features) |
| **Curious about the blockchain side** | [Part 3 — The blockchain layer](#part-3--the-blockchain-layer-web3) |
| **Responsible for the system** | [Part 5 — For administrators](#29-for-administrators) |

**A note on what SuppliWise is.** SuppliWise analyses a detailed health assessment and
produces a personalised supplement plan. It is a **wellness guidance tool, not a doctor**.
Every plan it produces carries a medical disclaimer and a recommendation to consult a
professional before you change anything you are taking. Please read Part 4 before you
rely on any of it.

---

## Table of contents

**Part 1 — Getting started**
1. [What SuppliWise actually does](#1-what-suppliwise-actually-does)
2. [Creating your account](#2-creating-your-account)
3. [Signing in](#3-signing-in)
4. [Your first assessment, step by step](#4-your-first-assessment-step-by-step)
5. [Reading your results](#5-reading-your-results)

**Part 2 — The features**
6. [The Dashboard](#6-the-dashboard)
7. [Recommendations](#7-recommendations)
8. [Track Intake — the daily habit](#8-track-intake--the-daily-habit)
9. [Insights](#9-insights)
10. [Assessment History](#10-assessment-history)
11. [Exporting a PDF report](#11-exporting-a-pdf-report)
12. [The AI Chat Assistant](#12-the-ai-chat-assistant)
13. [Support — talking to a human](#13-support--talking-to-a-human)
14. [Your profile and account security](#14-your-profile-and-account-security)
15. [Plans, pricing and upgrading](#15-plans-pricing-and-upgrading)

**Part 3 — The blockchain layer (Web3)**
16. [What the blockchain layer is for](#16-what-the-blockchain-layer-is-for)
17. [Your wallet and identity](#17-your-wallet-and-identity)
18. [Earning WELL](#18-earning-well)
19. [Achievements](#19-achievements)
20. [Staking](#20-staking)
21. [The marketplace, escrow and disputes](#21-the-marketplace-escrow-and-disputes)
22. [Your data and your consent](#22-your-data-and-your-consent)
23. [Verifiable AI recommendations](#23-verifiable-ai-recommendations)
24. [Community knowledge base and DAO voting](#24-community-knowledge-base-and-dao-voting)
25. [Trials, oracles and expert consultations](#25-trials-oracles-and-expert-consultations)
26. [The chain explorer and product verification](#26-the-chain-explorer-and-product-verification)

**Part 4 — Important things to know**
27. [Privacy: what is and is not recorded](#27-privacy-what-is-and-is-not-recorded)
28. [Troubleshooting](#28-troubleshooting)

**Part 5 — Reference**
29. [For administrators](#29-for-administrators)
30. [Glossary](#30-glossary)
31. [Feature → plan reference](#31-feature--plan-reference)

---

# Part 1 — Getting started

## 1. What SuppliWise actually does

Most supplement advice is generic. SuppliWise is different in five concrete ways:

### 1.1 It reads your whole picture, not a checkbox

You fill in a four-step assessment covering your age, diet, goals, medical conditions,
symptoms and their severity, sleep, water, habits, medications, allergies and blood tests.
The plan is generated from *that* — including the things you did not tick. Leave a field
empty and you get a more generic answer; fill it in and the plan gets sharper.

### 1.2 Every recommendation explains itself

Each card tells you:

- **"Recommended for:"** — the exact conditions, symptoms or goals that triggered it
- A **condition callout**, e.g. *"Since you reported Diabetes with moderate fatigue…"*
- Dosage, timing, interaction warnings
- **Expand the card** → the peer-reviewed evidence, with journal names and study IDs
- **Tap for Details** → a personalised deep-dive written for *your* profile

### 1.3 It works even if the AI is down

If the AI provider is unreachable, a built-in clinical rules engine takes over. You always
get a plan. You will simply get a less nuanced one.

### 1.4 It tracks whether you actually did it

A recommendation is worth nothing if you do not take it. SuppliWise tracks daily intake,
computes adherence, builds streaks and gives you a Wellness Score out of 100.

### 1.5 Every recommendation can be independently checked

You can anchor what the AI was given and what it produced to a tamper-evident log, then
later re-verify it. If the recommendation was quietly edited after the fact, verification
fails and you can see it. This is explained in [Part 3](#part-3--the-blockchain-layer-web3).

---

## 2. Creating your account

1. Open the site and click **Sign In → Create one**.
2. Fill in first name, last name, date of birth, gender, email and a password.
3. Solve the **maths CAPTCHA** — a small arithmetic question, used to stop automated sign-ups.
4. Click **Register**.

### Choosing a password

One policy applies everywhere in SuppliWise:

| Rule | Requirement |
|---|---|
| Length | **10 to 128 characters** |
| Uppercase | at least one `A–Z` |
| Lowercase | at least one `a–z` |
| Digit | at least one `0–9` |
| Symbol | at least one, e.g. `! @ # $ %` |

The form shows a live checklist and a 0–4 strength bar, and it refuses common passwords,
sequences like `password123`, and anything built from your own email address. Both rules
and the checklist come from the same server, so the form can never disagree with what is
actually enforced.

> **Tip:** a long passphrase ("correct-horse-battery-staple") beats a short complicated one.

---

## 3. Signing in

1. Enter your email and password, then click **Sign In**.
2. If you have set up a second factor, a **Login Verification** step appears — see
   [Two-Factor Authentication](#two-factor-authentication).

### "Save my login on this browser"

Tick this on a **personal device** to stay signed in for 30 days. The saved credential is
listed under **Account Security → Signed-in Devices** with a **Saved login** chip, and you
can revoke it at any time. Never tick it on a shared or public computer.

### Signing in with a passkey

If you have registered a passkey (fingerprint, Face ID, screen lock), the button **Sign in
with a passkey** appears under the password form. This is the strongest and fastest sign-in
method available, and it cannot be phished.

### Using several accounts at once

SuppliWise supports **multiple accounts across browser tabs**. Sign into account A in one
tab and account B in another and both stay live. Switch between them under
**Profile → Accounts**, or open the account menu in the top-right corner.

> Only **one session per account** is active. Signing in again on a new device or browser
> signs out the previous session *for that same account only* — your other accounts are
> untouched.

### If you are locked out

Repeated failed attempts escalate: **15 minutes → 1 hour → 6 hours → 24 hours**. Offences
decay after 30 days. If you cannot get in, use **Forgot your password?** — it sends a link
that works once and expires in 30 minutes.

---

## 4. Your first assessment, step by step

Go to **Dashboard → New Assessment**. The form is **Step 1 of 4**. Your progress is saved
in the browser, so you can navigate away and come back.

> ### ⚠️ Assessments are closed between midnight and 4:00 AM
> "Today's Supplements" resets at **4:00 AM in your own timezone**, and the assessment
> form is closed during the four hours before that reset. If you open it in that window
> you will see a "Reopens at …" message. **Your answers are saved** — come back after 4 AM.

### Step 1 — Basic Information

| Field | Notes |
|---|---|
| **Age** | Required. If you are signed in this is calculated from your date of birth and shown read-only. |
| **Gender** | Required. Drives which questions you are asked. |
| **Weight** | Required. Toggle between **kg** and **lbs**. |
| **Height** | Required. Toggle between **cm** and **ft / in**. |
| **Physical Activity Level** | `Sedentary`, `Light (1–3 days/week)`, `Moderate (3–5 days/week)`, `Very Active (6–7 days/week)`. Children under 13 skip this. |

### Step 2 — Diet & Health Goals

**Diet Type** — nine options, each with a `?` tooltip explaining it:

`Omnivore` · `Vegan` · `Keto` · `Paleo` · `Mediterranean` · `Carnivore` · `DASH` ·
`Flexitarian` · `Pescatarian`

**Health Goals** — pick as many as apply, grouped into:

- **General:** Increase Energy, Improve Sleep, Boost Immunity, Support Heart Health, Digestive Health
- **Fitness / Physical:** Muscle Gain, Fat Loss, Improve Strength, Improve Endurance
- **Fitness / Mental:** Mental Focus, Stress Reduction
- **Wellness:** Skin & Hair Health, Bone & Joint Health, Eye & Vision Health, Brain & Mental Health

> Children under 13 see a reduced, age-appropriate goal list.

### Step 3 — Medical Information and Current Symptoms

**Medical Conditions** — tick all that apply, or tick **None**:

- *Cardiovascular & Metabolic:* Hypertension (High Blood Pressure), High Cholesterol, Diabetes, Heart / Cardiovascular Disease, Obesity
- *Bone & Joint:* Arthritis, Osteoporosis, Gout
- *Digestive:* IBS (Irritable Bowel Syndrome), Celiac / Gluten Sensitivity
- *Respiratory & Immune:* Asthma, Autoimmune Disorders
- *Mental Health:* Anxiety Disorder, Depression
- *Other:* Thyroid Disorders, Anemia, Chronic Kidney Disease, Liver Disease, Migraine, and PCOS (female only)

**Current Symptoms** — how this works:

1. Tick **None** if you have no conditions → you get a general list of 15 symptoms.
2. Tick one or more conditions → you get, for each condition, a focused list of the
   symptoms relevant to it, plus a *"No symptoms for {condition}"* option.

**Every symptom you tick needs a severity: `Mild`, `Moderate` or `Severe`.** Each option
carries a short description so you can judge. If you skip a severity you cannot continue.

> Severity is not decoration. Severe cases are flagged for **Priority review**, and the AI
> is told to be more careful. Be honest.

### Step 4 — Lifestyle and Health Background

**Lifestyle**

| Field | Options |
|---|---|
| **Sleep Quality** | `Very Poor (<4 hrs)`, `Poor (4–5 hrs)`, `Average (6–7 hrs)`, `Good (7–8 hrs)`, `Excellent (8+ hrs)` |
| **Daily Water Intake** | `Less than 4 glasses`, `4–6`, `7–8`, `9 or more` |
| **Lifestyle Habits** | `Smoking`, `Alcohol`, `Recreational Drugs`, `None` |
| **Daily Sun Exposure** | `None`, `<15 min`, `15–30 min`, `30–60 min`, `1 hr+` |
| **Daily Protein Intake** | `Very Low (<50g)`, `Low (50–80g)`, `Moderate (80–120g)`, `High (120g+)`, `Not sure` |

> **If you tick Recreational Drugs**, a text box appears asking which ones. This is asked
> because some interact dangerously with prescribed medication. Your answer is treated
> confidentially and triggers a **Seeking Support** section in your results with four
> Philippine helplines: **DOH SAH 1550**, **DDB**, **DSWD Yakap Bayan**, **NCMH 1553**.

**Health Background**

| Question | What to enter |
|---|---|
| **Currently Taking Supplements?** | Yes/No. If yes, list them. Pre-filled from your current plan. |
| **Recent Blood Test?** | Yes/No. If yes, paste the findings, e.g. *"Low vitamin D (18 ng/mL), low ferritin (12), normal B12"*. |
| **Current Medications** | List them, or tick **None**. |
| **Known Allergies** | List them, or tick **None**. |

**Female-Specific Questions** (shown when gender is Female)

- **Pregnant?** Yes / No
- **Breastfeeding?** Yes / No

Both change the plan substantially — certain supplements are excluded or dosed differently.

All Step 4 fields are optional, but **the more you fill in, the more specific your plan**.
Everything you type is checked for spam and garbage text; junk is stripped and you are told
which fields looked unreadable.

### Getting your results

Click **Get Recommendations →**. An AI progress screen runs for about 10–20 seconds, then
your plan appears. See [Reading your results](#5-reading-your-results).

---

## 5. Reading your results

Your results page has a **Simplified / Detailed** toggle in the corner. Try both — Detailed
shows the evidence and citations.

| Section | What you get |
|---|---|
| **💊 Supplement Recommendations** | Up to 20 supplements, sorted High → Medium → Low priority, then by confidence score. |
| **🗓️ Your Daily Schedule & Recovery Plan** | When to take what, grouped by time of day. |
| **🌿 Lifestyle Recommendations** | Habits worth changing. |
| **🍽️ Meal Recommendations** | Diet-aware, allergy-safe, condition-specific meal ideas. |
| **Seeking Support** | Only if you reported recreational drug use. |
| **Banners** | "Wellness guidance, not a diagnosis" and "Medical Consultation Recommended". |

### The two buttons on each supplement card

| Button | What it does |
|---|---|
| **Add to Plan** | Adds the supplement to your daily plan. Click again to remove it. |
| **Tap for Details** | The AI writes a personalised long-form guide for *your* profile. Cached for 30 days, so re-reading costs nothing. |

### Reading the confidence score

Each card shows an animated confidence bar. It means **how strongly your profile supports
this supplement** — not how strong the science is. A low score with a high priority means
"this is important, but your answers did not strongly point at it; treat it cautiously."

### Supplements already in your plan

Anything already on your plan automatically sorts to the **bottom** of the list, so you can
see what is genuinely new at a glance.

---

# Part 2 — The features

## 6. The Dashboard

Your signed-in home page. Four action cards get you anywhere:

| Card | Goes to |
|---|---|
| **New Assessment** | `/assessment` |
| **Recommendations** | `/recommendations` |
| **Track Intake** | `/track-intake` |
| **Insights** | `/insights` |

Plus three live panels:

- **Today's Supplements** — your doses for the current plan day, tickable straight from
  the dashboard, with a taken count.
- **Wellness Score** — a gauge out of 100. Hover (or tap) **"How Wellness Score Works"**
  for the exact arithmetic.
- **Quick Stats** — Streak, Adherence rate, Today's Progress, Energy level.

### How your Wellness Score is calculated

| Component | Range | What it measures |
|---|---|---|
| AI baseline | 0 – 30 | How healthy your assessment says you are |
| Adherence bonus | 0 – 50 | How consistently you take your plan |
| Streak bonus | 0 – 20 | How long you have kept it up |
| **Total** | **0 – 100** | |

Missed doses reduce it. A dose taken *late* is **not** counted as missed — SuppliWise
knows the difference between "morning dose at 7 AM" and "morning dose at 2 PM".

### The 4 AM reset — the single most important thing to understand

**A "plan day" runs from 4:00 AM to 4:00 AM in your own timezone.**

This is deliberate. Almost nobody takes a supplement at 3 AM. If the day rolled over at
midnight you would be shown yesterday's unticked doses at 1 AM and your streak would
evaluate against a day you cannot see. So:

| Time (your timezone) | What you see |
|---|---|
| 04:00 – 23:59 | Today's plan day |
| 00:00 – 03:59 | Yesterday's plan day — **still the day that is running** |

Your timezone is read from your device. You never set it by hand, and SuppliWise cannot
be fooled into changing it by a header.

### Streaks

| Rule | Detail |
|---|---|
| Earning | Finish **100%** of your doses and you get **+1** |
| Undoing | Un-ticking before midnight reduces the streak |
| Midnight reset | An incomplete day resets the streak to 0 |
| One per day | A day can only ever add +1 |
| Adding mid-day | Adding a supplement after you have already completed the day breaks completion — it is a fresh obligation |

---

## 7. Recommendations

**Where:** Recommendations in the dashboard, or the top-right area nav.

- Filter tabs: **All Recommendations**, **High priority**, **Medium priority**, **Low priority**
- Search box
- **Simplified / Detailed** toggle
- Per card: **Add to my plan** / **In your plan**, and **Track today**
- **✓ Backed by research** / **📚 Evidence & References** expands to the citations
- A consult-a-doctor banner sits above the list

Three empty states, so the page is never blank without explanation: **No recommendations
yet**, **Your assessment is still being analysed**, **Nothing matches that search**.

---

## 8. Track Intake — the daily habit

**Where:** Track Intake in the dashboard.

- **Today's Supplements** — grouped into time slots (Morning, Afternoon, Evening, Night),
  each with a High / Medium / Low priority legend
- Tick a dose to mark it taken; tick again to undo
- **Missed doses** tray at the bottom
- **Overall Adherence** percentage
- **Calendar** — a visual month view of your completion history

Empty state offers **Take Assessment** or **Go to AI Recommendations** so a new account is
never staring at a blank tracker.

---

## 9. Insights

**Where:** Insights in the dashboard. *Requires Deluxe or above.*

Four tabs:

| Tab | Contents |
|---|---|
| **Overview** | At a Glance, Your Current Phase, Lifestyle Recommendations |
| **Today's Progress** | Today's completion with the current plan-day label |
| **Adherence** | A weekly bar chart plus your wellness journey phases |
| **AI Insight** | Personalised guidance for your phase |

On a lower plan the page shows a **PlanLockedCard** explaining what the upgrade buys, rather
than a dead screen.

---

## 10. Assessment History

**Where:** the History icon in the top navigation bar.

Four summary tiles: **Assessments**, **Active record**, **With AI analysis**, **Flagged
priority**, plus **Until next expiry**.

Each record can be:

- **Viewed** — all four steps of what you originally answered, including symptom choices
  and severities
- **Opened as results** — the full AI plan, in six tabs:
  `📋 Assessment` · `💊 Supplements` · `🗓️ Schedule & Recovery` · `🍽️ Meals` ·
  `🌿 Lifestyle` · `⚠️ Warnings` (plus `Seeking Support` when applicable)
- **Downloaded as PDF**
- **Deleted** — permanently

There is a search box and a status filter, and a **Start new** button.

**How much history you can page through depends on your plan:**

| Plan | Records per page |
|---|---|
| Free | 5 |
| Deluxe | 10 |
| Premium | 20 |
| Ultimate | 20 |

Below Premium the older pages show **More history is locked**.

**Your records are kept for five years.** If your days run out and you drop back to Free,
**nothing is deleted** — you simply lose access to the newer features.

---

## 11. Exporting a PDF report

**Where:** Export PDF on the results page, on a history record, or in the admin console.
*Requires Deluxe or above.*

The report is a formatted A4 document. Its cover states **who it was prepared for** and
**the date and time of generation**. It contains:

1. Clinical summary
2. Consult-a-doctor alert
3. Patient profile
4. Recommendations with dosage and timing
5. Evidence and RRL citations
6. Daily schedule
7. Lifestyle advice
8. Meal recommendations
9. Your 5-phase action plan
10. Warnings and things to avoid
11. Seeking Support resources, if applicable

There is also a dedicated **Security Report** export in the admin Security Center.

> **On a phone:** the Android app writes generated PDFs into your device's normal
> Downloads location, so they open in any PDF reader.

---

## 12. The AI Chat Assistant

**Where:** the floating **Ask AI** bubble on any member page. *Requires Ultimate.*

- Multi-turn conversation with history
- Quick prompt buttons to get you started
- **Typo tolerance** — misspell a supplement or condition and it gently corrects you
- **Scoped to health, nutrition and SuppliWise** — politely declines off-topic questions,
  and the guardrail is on the server, not just hidden in the interface
- Works offline with a canned local reply if the AI is unreachable

It is deliberately hidden on sign-in pages, `/support` and the whole admin area.

> **Chat is not Support.** See the next section — they are different products.

---

## 13. Support — talking to a human

**Where:** Support in the top navigation, or **Support** in the account menu.

This is a **real, stored conversation with a person** — not the AI. It requires a signed-in
account, because an administrator needs to know who to reply to.

- Open a thread with a category: **Payment**, **Billing & plans**, **My account**,
  **Technical**, **Something else**
- Reply and see the administrator's answer in the same transcript
- An unread badge, jump-to-latest, and auto-follow only when you are already at the bottom
- Filters: **All**, **With support**, **Your turn**, **Resolved**
- Once a thread is **resolved** it becomes read-only. An administrator can reopen it.

| | AI Chat Assistant | Support |
|---|---|---|
| Who answers | Software | A person |
| Stored? | No | Yes, permanently |
| Available on | Ultimate | Every plan |
| Good for | "Is magnesium safe with my medication?" | "My payment was taken but nothing happened" |

---

## 14. Your profile and account security

**Where:** click your avatar → **Personal Info** / **Edit Profile** / **Account Security** /
**Accounts** / **Plan & billing**.

### Personal Information

- Profile picture — drag and drop, or click to browse
- Profile banner — customisable
- First name, last name, date of birth
- Changing your **email or date of birth requires an OTP code** emailed to you, with a
  countdown before you can resend

### Account Security

Security lives in its own panels, deliberately kept away from "Edit your name".

| Panel | What it does |
|---|---|
| **Passkeys** | Register, rename and remove fingerprint / Face ID / screen-lock keys |
| **Two-Factor Authentication** | Authenticator app or email codes, with a strength indicator |
| **Change Password** | Current + new password against the shared policy, with a live checklist |
| **Recovery Codes** | Ten single-use codes. Viewed **once**. Can be regenerated or invalidated |
| **Recovery Email** | A second address, OTP-verified, for when you lose your phone |
| **Signed-in Devices** | Every device with its label, platform, location, IP and sign-in method |
| **Login & Security Activity** | A newest-first feed of your own security events |

Plus a **Step-up dialog** — the "Confirm it's you" prompt, asking for your password **and**
your current authenticator code, before any security change is allowed.

#### Two-Factor Authentication

| Method | Strength | Notes |
|---|---|---|
| **Authenticator app** | Strongest | 6-digit code that changes every 30 seconds (Google Authenticator or any TOTP app) |
| **Email codes** | Weaker | 6-digit code sent to your account email |

- Turning 2FA **on** or **off** requires step-up verification
- Turning it off deletes the authenticator secret **and** destroys all recovery codes
- Removing your last strong method is **refused** — you cannot lock yourself out
- If 2FA is on but the secret is unreadable, SuppliWise **falls back to email codes**
  rather than locking you out permanently

> **Set up a recovery email and save your recovery codes somewhere offline.** Losing your
> phone with no recovery method is the single most common way people get locked out.

#### Managing devices

Under **Signed-in Devices** you can **Sign out** any single device, or **Sign out all other
devices**. Devices marked **This device** is you right now; **Saved login** means the
30-day "save my login" credential.

### Accounts

Add another account, switch between them, or sign any of them out — independently.

---

## 15. Plans, pricing and upgrading

**Where:** **Plans** in the top navigation. The page is **public** — you do not need an
account to compare plans.

| Plan | Unlocks |
|---|---|
| **Free** | Health Assessment, Supplement Recommendations, Daily Intake |
| **Deluxe** | + Insights & Analytics, PDF Report Export, **the entire blockchain layer** |
| **Premium** | + Priority Assessment, 5-Year Record History |
| **Ultimate** | + AI Chat Assistant — everything SuppliWise has |

There are exactly four plans.

### How billing actually works

- A purchase is exactly **30 days**. **Nothing renews automatically.**
- Buying again **extends** your window rather than restarting it — no paid day is ever lost.
- Changing plan applies **immediately**, with no sign-out.
- When your days run out you return to Free. **Your assessments and history are kept.**
- There are no automatic charges and no refunds. Every "refund" you will see in the
  marketplace is Web3 escrow, which is a different thing entirely.

### How to upgrade

1. Open **Plans**, pick your plan and your currency.
2. You are shown the amount, computed **on the server**.
3. Submit the request with a **payment reference** and, optionally, a photo of your proof
   of payment.
4. An **administrator reviews** it and approves (optionally adjusting the number of days
   granted) or declines with a note.
5. Your new plan is live immediately. You do not sign out.

Cancelling runs through the same review process in the opposite direction.

### Currency

Base prices are held in **PHP on the server** and every other currency is derived there, so
a displayed price can never disagree with the charged price. Detection order: your saved
preference → a `?currency=` link → your browser language → your location → PHP. The picker
always tells you where the number came from.

### What you see when a feature is locked

Locked features render a **PlanLockedCard**, not a dead end. It tells you:

1. What the feature is **worth** first
2. The literal gap — *"you are on Free, this needs Deluxe"*
3. Exactly what the upgrade buys

---

# Part 3 — The blockchain layer (Web3)

*Everything in this part requires **Deluxe or above**.*

## 16. What the blockchain layer is for

### You do not need to understand blockchain

SuppliWise runs a **self-contained proof-of-work log inside the app**. There is no external
network, no gas fees, no crypto wallet to fund, and nothing to install. Your account simply
gets a wallet the first time you open the Web3 area, with **100 WELL** already in it.

WELL is a points token. You cannot buy it with real money and you cannot cash it out. It is
used for marketplace trading, staking, loyalty discounts and expert bookings.

### What it actually gives you

| Goal | Which feature |
|---|---|
| "Is this bottle genuine?" | [Product verification](#26-the-chain-explorer-and-product-verification) |
| "Prove a recommendation has not been quietly edited" | [Verifiable AI](#23-verifiable-ai-recommendations) |
| "Hand my doctor my history without an account" | [Shareable profile](#share-your-profile--public-link-no-account-needed) |
| "Sell supplements safely, buyer-protected" | [Marketplace & escrow](#21-the-marketplace-escrow-and-disputes) |
| "Have a say in how the platform's economics work" | [DAO voting](#24-community-knowledge-base-and-dao-voting) |
| "Earn something for staying consistent" | [WELL rewards](#18-earning-well) |

### The one rule that matters

> **Your personal health data is never written on the blockchain.** Only a SHA-256
> fingerprint is. Your records stay in the application's own database.

See [Privacy](#27-privacy-what-is-and-is-not-recorded) for the detail.

### Where things are

| Screen | Route | Contains |
|---|---|---|
| **Web3 Hub** | `/web3` | 8 tabs: Wallet & Identity, Rewards & NFTs, Health Ledger, Privacy & Data, AI Proof, Trials & Oracles, Supply Chain, Block Explorer |
| **Marketplace** | `/marketplace` | Browse, My Orders, Sell, Disputes |
| **DAO Governance** | `/governance` | Proposals, New Proposal, Knowledge Base |
| **Verify a product** | `/verify` | Public — no account needed |

Administrators cannot use any of it. They have no health profile and no wallet, and the
server rejects them.

---

## 17. Your wallet and identity

**Where:** Web3 Hub → **Wallet & Identity**.

The first time you open it, SuppliWise creates your wallet automatically and credits your
**100 WELL welcome bonus**. You will see:

- **DID** — `did:suppliwise:…`, your decentralised identifier
- **Address** — `0x…`, your public account on the SuppliWise chain
- **WELL balance** and, if you stake, your **staked** amount
- **ed25519 public key** — used to sign your health credentials

### Exporting your private key

**Export private key** gives you a standard **PKCS#8 PEM** file
(`-----BEGIN PRIVATE KEY----- …`).

> ⚠️ **Anyone holding this key controls your wallet.** Store it offline — a password
> manager, a hardware wallet, a printed copy in a safe. Never paste it into a website, a
> chat, or a screenshot. SuppliWise stores it encrypted and only decrypts it for you, but
> the export is final.

---

## 18. Earning WELL

**Where:** Web3 Hub → **Rewards & NFTs**.

| Action | Reward | Rule |
|---|---|---|
| **Daily check-in** | 5 WELL + 1 per consecutive day, capped at +10 | One tap per day. A second tap returns *"already claimed"* and mints nothing |
| **Intake reward** | 5 WELL | Only unlocks once you have actually logged a dose today |
| **Assessment reward** | 15 WELL | Once per assessment |
| **Data-sharing reward** | 25 WELL | See [Your data and your consent](#22-your-data-and-your-consent) |
| **Health-ledger anchor** | 3 WELL | Once per day |
| **Publish a knowledge post** | 10 WELL | See [Knowledge base](#24-community-knowledge-base-and-dao-voting) |
| **Receive an upvote** | 2 WELL each, capped at 40 total | |
| **Upvote someone's post** | 1 WELL | The curator reward |

The intake and assessment buttons stay **locked** until the server confirms the real
activity happened — you cannot farm them by clicking.

### Viewing your reward history

**History** lists every reward with the exact block and transaction that recorded it, each
row linking to the chain explorer.

> **Why you cannot double-dip:** the database enforces one reward per
> *(user, activity, reference)*. A second attempt is rejected at the database level, not
> merely hidden in the interface.

---

## 19. Achievements

**Where:** Web3 Hub → **Rewards & NFTs** → **Achievements**.

Eleven milestones, detected from your **real** activity: first assessment, 7-day streak,
data pioneer, governor, market participant, trailblazer, verified professional, and more.

Press **Check achievements** and anything you now qualify for is minted with a token ID, an
edition number and an on-chain mint record.

Achievements are **soulbound** — earned once, never re-minted. Pressing the button again
simply mints nothing.

---

## 20. Staking

**Where:** Web3 Hub → **Rewards & NFTs** → **Staking**.

| Action | Effect |
|---|---|
| **Stake** | Moves WELL from your spendable balance into your staked balance |
| **Unstake** | Returns it — any amount, any time |
| **Yield** | **12% APY**, credited automatically the next time your wallet is used, pro-rated for elapsed time |

Reaching the governance threshold (**500 WELL staked**) unlocks premium perks; a progress bar
shows how close you are.

Staked WELL also increases your **DAO voting weight**.

---

## 21. The marketplace, escrow and disputes

**Where:** Marketplace.

### Selling

Create a listing — title, brand, category, price in WELL, stock. Your listing is anchored
on-chain. The first six demo products are sold by the official SuppliWise brand wallet, so
you can try buying before you ever sell.

### Buying, with escrow protection

```flow
You place an order
  Your WELL moves into escrow
    The seller cannot touch it
      Product arrives
        You confirm delivery
          Seller is paid, minus the 3% protocol fee
            Fee goes to the treasury
```

The 3% fee is shown on the order before you commit. **The seller is not paid until you
confirm delivery.**

### If something is wrong

1. Open the order → **Open dispute** and describe the problem (at least 10 characters).
2. Independent **jurors** — WELL holders who staked, and who are **not** part of the order —
   are appointed and vote.
3. Outcome:

| Verdict | Result |
|---|---|
| **Buyer wins** | Full refund, stock returned |
| **Seller wins** | Escrow released to the seller |
| **Tie** | **Nobody is paid** until there is a clear verdict |

Jurors are paid for their service, and their votes are weighted by their stake.

**You can never vote on your own dispute**, and both buyer and seller are excluded from the
jury. That is enforced on the server, not just hidden in the interface.

### Loyalty codes

**Rewards → Loyalty** — redeem 10+ WELL for a one-time `LOY-…` code. Apply it at checkout
to reduce the order total. Codes are **single use**; a used code is rejected.

---

## 22. Your data and your consent

**Where:** Web3 Hub → **Privacy & Data** and **Health Ledger**.

### Your health ledger

A rolling **digest** — a SHA-256 fingerprint — of your assessments and intake history,
plus snapshots anchored to the chain.

> The chain stores the **digest and counts**. It never stores your health data.

### Verifiable export

Export a **signed health credential** to hand to a doctor or nutritionist. It carries a
digital signature, so the recipient can confirm it came from you and was not altered.

### Share your profile — public link, no account needed

Generate a **time-boxed link** (1 hour to 30 days) that opens a read-only clinician view of
your summary. **Your doctor does not need a SuppliWise account.**

You can revoke a link at any moment and it stops working **immediately**. The view carries a
disclaimer that it is not a diagnosis, and shows an integrity anchor.

### Share anonymised data for research — earn 25 WELL

Name a research institution and pick a scope. SuppliWise then builds the dataset **on the
server**:

- **Coarse bands only** — age band, gender, volume bands
- **Never** your name, exact dates, identifiers or free text
- Encrypted at rest and stored under a content address
- Your **consent is anchored** on-chain

**You can revoke at any time.** Revoking anchors the revocation *and destroys the stored
dataset*, so it can no longer be retrieved — not merely hidden.

### Encrypted storage

Store any JSON payload — notes, records, exports — encrypted with AES-256-GCM under a
`bafy…` content ID. Fetching it re-checks the content ID, so tampering is detectable.

Revoking a data share destroys only that dataset. Your other stored items are untouched.

---

## 23. Verifiable AI recommendations

**Where:** Web3 Hub → **AI Proof**, or the results of an assessment.

This is the feature that answers *"did they change my recommendation without telling me?"*

**How to use it**

1. After an assessment, **anchor** it. SuppliWise hashes **three things separately**: what
   the AI was *given*, what it *produced*, and which *logic version* produced it.
2. That combined hash is anchored on-chain.
3. Later, **re-verify**. SuppliWise recomputes all three from the stored record.

**If the inputs or outputs were altered after anchoring, verification fails and you can see
it.** If nothing changed, it passes.

---

## 24. Community knowledge base and DAO voting

**Where:** Governance.

### Knowledge Base

Publish a **🧾 Product review**, **🔬 Research finding** or **💬 Success story** and earn
WELL immediately. Other members can upvote: they earn a small curator reward, you earn more
up to a cap.

**You cannot upvote your own post, and nobody can upvote twice.**

### Governance

Any proposal can change the platform's economic parameters — the daily check-in reward, the
marketplace fee, the staking APY, the quorum, and more.

1. **Create a proposal** — title, description, and optionally which parameter to change.
   Your own proposal vote is cast automatically with your weight.
2. **Vote** for or against other proposals. **One vote per wallet**, weighted by
   `balance + staked` at the moment you vote.
3. A proposal **passes** when total voting weight reaches the **quorum** *and* FOR strictly
   outweighs AGAINST. **Ties fail.**
4. When the voting period ends the outcome is finalised automatically, and a passed
   proposal **actually changes the platform's settings** — with the execution recorded
   on-chain.

---

## 25. Trials, oracles and expert consultations

**Where:** Web3 Hub → **Trials & Oracles**.

### Clinical trials

Browse open studies. Opting in hashes the **exact terms** — sponsor, data scope,
revocability, reward — and anchors them on-chain, then pays the participation reward.

**You can withdraw at any time, and the withdrawal is anchored too.** One consent per trial.

### Oracle feeds

Live reference feeds for supplement prices, a WELL index and research signals. Each is
re-derived daily and anchored whenever a value changes. The same values appear next to
marketplace listings, so you can sanity-check a seller's price.

### Expert consultations

Four verified professionals: clinical nutrition, functional medicine, sports nutrition and
micronutrient research.

Booking pays `rate × hours` in WELL into the professional's pool, recorded on-chain. **Cancel
for a full refund.**

---

## 26. The chain explorer and product verification

### Product verification — public, no account

**Where:** `/verify`, or the QR code on the bottle.

1. Scan the **QR code**, or type the printed `SW-XXXXXXXX` code into the box.
2. You get a verdict:

| Verdict | Meaning |
|---|---|
| ✅ **AUTHENTIC & VERIFIED** | The journey is anchored and every proof re-checked |
| ⚠️ **PROOF INCOMPLETE** | Partially anchored — treat with caution |
| ⚠️ **NOT VERIFIED** | Unknown code, or a proof could not be confirmed. **Do not trust the product.** |

3. The page shows the **full journey** — raw material → manufacturing → lab testing →
   quality release → distribution → retail → delivered — with each step's location, who
   recorded it and its block number, plus every **certification** (lab report, organic,
   non-GMO, GMP) with the digest of the result document.

Everything on this page is **recomputed from the chain when you open it**. It is evidence,
not marketing copy.

### The chain explorer

**Where:** Web3 Hub → **Block Explorer**.

Every action in Part 3 — reward, transfer, consent, certification, vote, order settlement —
is anchored as a transaction in a proof-of-work chain. The explorer shows recent blocks, the
chain tip, the current difficulty, and lets you look up any transaction by hash.

**Verify chain** recomputes every block hash from scratch and reports whether the history is
intact.

---

# Part 4 — Important things to know

## 27. Privacy: what is and is not recorded

This section is the most important one in the manual.

### What is NEVER written to the blockchain

- Your name, email or profile picture
- Your health conditions, symptoms, medications or allergies
- Your assessment answers, in whole or in part
- Your date of birth or exact dates
- Anything you typed in a free-text box

### What IS written

| Written on-chain | In the form of |
|---|---|
| Your health ledger | A SHA-256 **digest** plus counts |
| A research dataset you consent to share | A **coarse, anonymised, revocable** record — age band, gender, volume bands |
| A recommendation | Three hashes: inputs, outputs, logic version |
| A consent decision | A hash of the terms |
| A certification | The result document's digest |

The database holds your actual records. The chain holds **proof that those records have not
changed**.

### What you control

| Control | Where |
|---|---|
| Revoke a shared profile link | Privacy & Data |
| Revoke research consent — **and destroy the dataset** | Privacy & Data |
| Sign out a device | Account Security → Signed-in Devices |
| Sign out everywhere else | Account Security |
| Delete an assessment | History |
| Disable 2FA and destroy recovery codes | Account Security |

### Who can see what

| Surface | Who can access |
|---|---|
| Product verification page | **Anyone**, no account |
| Shared health profile link | **Anyone** with the link, no account, time-boxed |
| Your dashboard, history, wallet | **You only** |
| Support threads | **You and the administrators** |
| Admin console | **Administrators only**, behind a mandatory authenticator step |

---

## 28. Troubleshooting

| Symptom | What it means and what to do |
|---|---|
| **"Assessments are closed between midnight and 4 AM"** | Working as designed. Your plan day resets at 4 AM *your* time. Answers are saved — return after 4 AM. |
| **Yesterday's doses still showing in the morning** | You are between midnight and 4 AM. That day is still running. |
| **A locked feature says "DELUXE plan"** | Genuinely a plan gate. Open **Plans** to upgrade; it applies instantly, no sign-out. |
| **"Your assessment is still being analysed"** | The AI call is in flight. It normally takes 10–20 seconds. |
| **Recommendations failed / generic answers** | Every AI provider is unreachable, so the rule-based clinical engine ran instead. Results are still valid but less specific. |
| **Chat says it is unavailable** | Either you are not on Ultimate, or the AI is down and there is no fallback reply for your question. |
| **Locked out after failed sign-ins** | The escalating lockout: 15 min → 1 h → 6 h → 24 h. Wait it out, or use **Forgot your password?** |
| **No email OTP arrives** | Check spam. Codes expire after 10 minutes and resending has a 30-second cooldown. Email codes are the *weaker* method — switch to an authenticator app. |
| **Lost my phone with 2FA on** | Use a **recovery code**, or the **recovery email**. If you set up neither, this is why the setup screen insists on it. |
| **Passkey not offered** | Your browser or device does not support WebAuthn. Use your password. |
| **PDF button missing** | PDF export requires Deluxe. |
| **"Load older assessments" locked** | Deep history requires Premium. |
| **Marketplace / Web3 / DAO shows an upgrade card** | The blockchain layer requires Deluxe. |
| **A reward button says "already claimed"** | Working as designed — one claim per activity per day. |
| **A WELL reward button is greyed out** | The server has not confirmed the real activity. Log a dose, or complete an assessment, first. |
| **A dispute did not resolve instantly** | Verdicts need the appointed jurors to vote. **Ties deliberately pay nobody.** |
| **Verify chain reports a problem** | Contact support via `/support`. Quote the block number it names. |
| **Page is blank after a deployment** | The app self-heals a stale cached bundle automatically. If it persists, hard-refresh. |
| **Something else is wrong** | Use **Support**. It is a real person, and it is stored. |

---

# Part 5 — Reference

## 29. For administrators

Administrators use a **separate console** at `/admin`, guarded by an alias + password **and
a mandatory authenticator challenge**. It is a different product surface from the member
app and is never reachable from member navigation.

### Signing in

1. Go to `/admin/login`.
2. Enter your alias and password.
3. Enter your 6-digit authenticator code.

If your password is a temporary one you are forced to set a new one before anything else
opens. The console signs itself out after **10 minutes of inactivity**, with a live
countdown driven by the same server value.

### The eight console tabs

| Tab | What it gives you |
|---|---|
| **Overview** | Users, assessments, active/inactive, a 14-day activity chart, plan mix, 2FA adoption, signups, recent signups, threats |
| **User management** | Search, filter, expand a user, ban/unban, clear a lockout, delete permanently, edit their subscription inline |
| **Admin management** | The admin roster, enable/disable, clear lockouts |
| **Subscription management** | Approve or decline plan requests and cancellations, with proof-of-payment images and overridable day grants |
| **Chat management** | The support inbox — two panes, status filters, keyboard triage |
| **Assessment Management** | Per-member assessment lists, read-only view, AI results, PDF export, modify or delete |
| **AI management** | Which AI providers are actually reachable, and which are merely configured |
| **Security** | The live 45-probe monitor, the static audit record, and the security report export |

### Approving a subscription

1. **Subscription management**.
2. Find the pending request; check the payment reference and the proof-of-payment image.
3. **Approve** — optionally adjust how many days are granted — or **Decline** with a note.
4. The member sees the decision and the plan is live immediately.

### The live security monitor

**Security** runs **45 probes** — 25 core platform and 20 blockchain — every 30 seconds. Each
shows Healthy / Warning / Critical / Error, which framework implements it, the implementing
file, and its latency. Use **?fresh=1 sync** to force a check, and the summary tiles at the
top for an at-a-glance verdict.

---

## 30. Glossary

| Term | Meaning in plain English |
|---|---|
| **Anchor** | Writing a proof into the tamper-evident log |
| **Assessment** | The four-step health questionnaire and its AI output |
| **Blockchain** | The append-only log of proofs. Here, it runs inside SuppliWise — there is no external network |
| **CID** | A content address (`bafy…`) derived from a file's bytes, so tampering changes the ID |
| **DAO** | Decentralised Autonomous Organisation — members vote on platform parameters here |
| **Dead hours** | Midnight to 4:00 AM local, when a new plan day has not started yet |
| **DID** | Your decentralised identifier, `did:suppliwise:…` |
| **Escrow** | Funds held by the platform until delivery is confirmed |
| **Juror** | An independent staked holder who votes on a dispute |
| **Oracle feed** | A published reference value, e.g. a supplement price |
| **Plan day** | The 4 AM-to-4 AM day your tracker scores |
| **Priority review** | A flag on a severe assessment that pauses new submissions while it is reviewed |
| **Proof-of-work** | The method used to order and seal the log so it cannot be rewritten |
| **SHA-256 digest** | A one-way fingerprint. It proves something has not changed without revealing what it is |
| **Soulbound** | Earned once, never transferable or re-minted |
| **Stake** | WELL set aside, which earns APY and increases voting weight |
| **WELL** | The in-app points token. Not purchasable with money, not cashable |

---

## 31. Feature → plan reference

| Feature | Free | Deluxe | Premium | Ultimate |
|---|:--:|:--:|:--:|:--:|
| Health Assessment | ✅ | ✅ | ✅ | ✅ |
| Supplement Recommendations | ✅ | ✅ | ✅ | ✅ |
| Daily Intake tracking | ✅ | ✅ | ✅ | ✅ |
| Insights & Analytics | 🔒 | ✅ | ✅ | ✅ |
| PDF Report Export | 🔒 | ✅ | ✅ | ✅ |
| Web3 wallet, supply chain & proofs | 🔒 | ✅ | ✅ | ✅ |
| Marketplace | 🔒 | ✅ | ✅ | ✅ |
| DAO Governance | 🔒 | ✅ | ✅ | ✅ |
| Priority Assessment | 🔒 | 🔒 | ✅ | ✅ |
| 5-Year Record History | 🔒 | 🔒 | ✅ | ✅ |
| AI Chat Assistant | 🔒 | 🔒 | 🔒 | ✅ |
| History records per page | 5 | 10 | 20 | 20 |

*🔒 = requires an upgrade. 🔒 🔒 = requires a higher tier. Every gate is enforced on the
server, not only hidden in the interface.*

---

<div align="center">

**SuppliWise** — *Stop guessing. Start knowing.*

Wellness guidance, not a diagnosis. Always consult a qualified healthcare professional
before starting, stopping or changing any supplement or medication.

</div>
