# Data flow analysis — AI features, AI provider training, and the system

This document traces every byte that the AI features of SuppliWise move: what a member
types, what the server adds to it, what leaves the building toward a model provider, what
comes back, what the server is allowed to change before a human reads it, and what is
written to the database afterwards. It then does the same for the training and
self-learning path, and finally for the non-AI subsystems, because the AI surfaces inherit
every boundary the rest of the system draws.

Everything here is **descriptive, not aspirational**. Each claim carries a `file:line`
reference into the `Main-3-F` tree. Where a control is missing, the missing control is
stated in the same voice as the ones present — section 14 is that list, and it is the part
to read before signing off on this area.

---

## Table of contents

1. [Vocabulary and the four trust boundaries](#1-vocabulary-and-the-four-trust-boundaries)
2. [The AI surfaces at a glance](#2-the-ai-surfaces-at-a-glance)
3. [Inbound: what a client is allowed to send](#3-inbound-what-a-client-is-allowed-to-send)
4. [Assembly: what the server puts in front of a model](#4-assembly-what-the-server-puts-in-front-of-a-model)
5. [Outbound: the provider layer](#5-outbound-the-provider-layer)
6. [Post-generation: the verification layer](#6-post-generation-the-verification-layer)
7. [Persistence: what is stored and in what state](#7-persistence-what-is-stored-and-in-what-state)
8. [Retrieval-augmented generation](#8-retrieval-augmented-generation)
9. [The self-learning loop](#9-the-self-learning-loop)
10. [Feedback priors: the second learning path](#10-feedback-priors-the-second-learning-path)
11. [Fine-tune export: what "train the model" means with API keys](#11-fine-tune-export-what-train-the-model-means-with-api-keys)
12. [Data that deliberately never reaches a model](#12-data-that-deliberately-never-reaches-a-model)
13. [System-wide flow outside the AI features](#13-system-wide-flow-outside-the-ai-features)
14. [Open gaps and operator obligations](#14-open-gaps-and-operator-obligations)
15. [First-party research input: the pharmacy interview](#15-first-party-research-input-the-pharmacy-interview)
16. [Which gate proves which claim](#16-which-gate-proves-which-claim)
17. [Key files](#17-key-files)

---

## 1. Vocabulary and the four trust boundaries

Three verbs are used precisely throughout:

- **Neutralised** — control characters, prompt-injection markers and instruction-shaped
  lines removed or defanged, length bounded (`utils/aiGuardrails.js`).
- **Projected** — copied through a named allowlist, so a schema field added tomorrow is
  invisible until someone adds it to the list (`utils/chatIdentity.js:35-51`).
- **Grounded / verified** — checked after generation against data the app itself holds, and
  rewritten or deleted when it fails (`utils/planGrounding.js`).

The four boundaries every flow crosses:

```
  Member's browser
        │  (1) client → server: untrusted input, bounded and neutralised
        ▼
  API server  ──  prompt assembly  ──  (2) server → provider: the only place
        │                                    health prose leaves the building
        ▼
  Verification layer  ──  (3) provider → member: nothing ships unchecked
        │
        ▼
  Mongo + chain  ──  (4) server → at rest: what is encrypted, what is plaintext,
                                   what is public
```

Boundary (2) is the one that matters most, because it is the only irreversible one. A
model provider is a third party processing health disclosures under an API contract; the
app's answer is not to refuse the call but to send the **smallest true statement** that
lets the model do its job, and to keep a written record of what it was shown
(`AiChatThread.turns`, section 7).

---

## 2. The AI surfaces at a glance

| Surface | Route | Gate | Rate limit | AI purpose key | Verified by |
|---|---|---|---|---|---|
| AI chat assistant | `POST /api/chat` `routes/chat.js:188` | `protect` + `requireFeature('chat')` (min tier `custom`, `utils/entitlements.js:46`) | 20/min per **user id** `routes/chat.js:28-34` | `chat` | `verifyProse()` `routes/chat.js:372` |
| Chat vote | `POST /api/chat/feedback` `routes/chat.js:519` | `protect` + `requireFeature('chat')` | 60/min per user `routes/chat.js:510` | none — no provider call | n/a |
| Chat history | `GET/PATCH/DELETE /api/chat/threads*` `routes/chat.js:575-675` | `protect` + `requireFeature('chat')` | `userLimiter` 120/min `index.js:445` | none | n/a |
| Health-description polish | `POST /api/polish` `routes/polish.js:15` | `protect` only | `aiLimiter` 60/10 min `index.js:450` | `polish` | `stripUnverifiableIdentifiers()` `routes/polish.js:112` |
| Supplement guide | `POST /api/supplement-detail` `routes/supplement_detail.js:275` | `protect` only | `aiLimiter` 60/10 min `index.js:451` | `supplementDetail` | `verifyGuide()` `routes/supplement_detail.js:247` |
| Plan generation | `POST /api/recommend` `routes/recommend.js:49` | `protect` only | `recommendLimiter` 15/10 min `index.js:444` | `assessment` | `groundPlan()` `routes/recommend.js:184` |
| Priority second opinion | inside `POST /api/assessment` `routes/assessment.js:263` | `protect`; flag only applied when `can(user,'priorityAssessment')` (tier `annual`, `entitlements.js:44`) | `userLimiter` 120/min `index.js:440` | `priorityFlagging` | reply parsed and range-checked `utils/priorityFlagging.js:358` |
| System threat detection | admin monitor path | `adminOnly` | `adminLimiter` 60/min `index.js:477` | `systemDetection` | rule-based fallback kept |
| Admin key/routing check | `GET /api/admin/ai`, `POST /api/admin/ai/check` `routes/admin.js:2760,2769` | `adminOnly` | as above | probe traffic only | n/a |

Two things worth noting about that table, because both surprise people.

**Only chat is subscription-gated.** `polish`, `supplement-detail`, `recommend` and
`assessment` are authenticated but not entitlement-checked, so any signed-in member can
reach a provider through them. The limiter is what stands between that and a bill.

**There is no AI streaming.** `/api/chat` is a single request/response; SSE exists only for
the human support channel (`routes/supportChat.js:311`). A chat reply is therefore always
fully available to the verifier before the client ever sees a character of it — which is
what makes section 6 possible at all.

---

## 3. Inbound: what a client is allowed to send

Every AI route is a JSON body under a global 1 MiB cap (`index.js:484,520`; a separate
15 MiB parser exists only for base64 pictures on three profile routes). Past that ceiling
the request is refused before parsing, and the refusal path deliberately does not dump the
body (`index.js:505`).

| Body field | Cap | Where enforced |
|---|---|---|
| `message` | 1000 chars | `utils/chatSafety.js:3`, applied `chatSafety.js:97` |
| `history` | ≤20 items, each ≤500 chars, **truncated to the last 8** | `chatSafety.js:92-94` |
| `context` (chat) | validated, then **discarded** | `routes/chat.js:259-262` |
| `text` (polish) | 1000 chars | `routes/polish.js:32` |
| `supplementName` | 200 chars | `routes/supplement_detail.js:278` |
| `context` (supplement guide) | client-supplied, per-field caps 40–500 | `routes/supplement_detail.js:65-84` |
| medications / blood results | 1000 chars | `routes/recommend.js:58-67` |
| allergies / supplements | 200 chars | `routes/recommend.js:58-67` |
| `feelingDescription` | 1000 chars | `routes/assessment.js:242` |

The chat client's `context` field is validated and then ignored (`routes/chat.js:259-262`).
That is a decision, not an oversight: a client that could choose its own retrieval context
could steer the assistant toward whatever note it liked. The supplement-guide `context`, by
contrast, **is** client-supplied and **is** used — it is neutralised field by field
(`supplement_detail.js:65-84`) and fenced, but it remains the one AI surface whose profile
data arrives over the wire rather than from the database. A caller can therefore obtain a
guide for a patient profile that is not real. It cannot obtain anyone else's data, because
the guide is generic to the profile it is given.

The one boundary that has no bypass is prompt-injection neutralisation: every free-text
line that enters a prompt goes through `promptSafe` → `neutralize`
(`utils/assessmentPrompt.js:43`) or the equivalent in the surface that assembles it.

---

## 4. Assembly: what the server puts in front of a model

This is the section to read if you want to know exactly what a third party learns about a
member.

### 4.1 Chat

Three separate blocks are added to the member's message:

1. **Identity block** — an allowlist projection built by `identityForChat()`
   (`routes/chat.js:304` → `utils/chatIdentity.js:109`). It carries the **first and last
   name** on the account (`NAME_FIELDS`, `chatIdentity.js:35`) plus these questionnaire
   answers and nothing else: `age, weight, height, activityLevel, dietType, sleepQuality,
   stressLevel, waterIntake, proteinIntake, fitnessFocus, sunExposure, pregnancyStatus,
   takingSupplements, currentSupplements, recentBloodTest, bloodTestResults,
   currentMedications, allergies, feelingDescription` (`ASSESSMENT_FIELDS`,
   `chatIdentity.js:41-46`) and `symptoms, medicalConditions, healthGoals, lifestyleHabits`
   (`LIST_FIELDS`, `:48`). Caps: 48 chars for a name, 6 list items, 160 chars per text field
   (`:49-51`). The source query is a single explicit `select()` on the member's own
   assessment (`routes/chat.js:272`).
2. **Recommendation context** — name, priority, confidence and reason of up to 5 saved plan
   rows, capped 120/40/240 (`utils/chatSafety.js:126-147`).
3. **Retrieved notes** — up to 6 BM25 hits, 3,200 chars total (section 8).

Age and gender come from the assessment rather than `User.dateOfBirth`, deliberately: the
member reported a number, and the app never needs their actual birth date to answer "how old
did I tell you I am" (`chatIdentity.js:39-41`). `gender` is excluded from the parts list for
a second, uglier reason — mixing it in is how "Maria Santos Female" becomes somebody's
surname (`chatIdentity.js:32-34`).

The model is also **told what it cannot see**, by name, in `IDENTITY_POLICY`
(`chatIdentity.js:175-186`). That is not decoration: a model that is not told it has no
email address will invent one when asked, and a fabricated address on screen is something a
member mails their lab results to.

### 4.2 Plan generation

`buildPatientData()` (`utils/assessmentPrompt.js:59-128`) puts age, gender, weight, height,
derived BMI, activity level, diet type, health goals, symptoms with severity, sleep quality,
stress, water and protein intake, lifestyle habits, pregnancy status, current supplements
and medications, recent blood test and results, allergies, sun exposure, fitness focus, and
`feelingDescription` truncated to 500 chars (`:122`) into a fenced `<patient_data>` block.
Only fields the member actually answered are emitted (`:83`). **No name, no email, no user
id** — the plan prompt is about a body, not a person.

To that is added the member's own history: previous plans' recommendation names and
priorities plus answer fields (`utils/memberHistory.js:66-73,269,281`), rendered as fenced
lines at 800 chars (`:230-259`) and inserted at `assessmentPrompt.js:213-217`. This is what
makes a second plan differ from the first.

The whole request body is otherwise spread into the prompt (`routes/recommend.js:113-120`),
which is why its caps live at the route rather than in the builder.

### 4.3 Priority flagging

`buildSignals()` sends age, gender (40 chars), symptoms, up to 6 severity entries,
conditions, medications, blood test fields, `feelingDescription`, and the rule engine's own
warnings and avoid-list (≤5 each) as JSON (`utils/priorityFlagging.js:191-220`, wire body
`:334`). Note what is *not* there: no name. The output of this surface can only ever
**escalate** a flag to human review, never clear one (`aiRouter.js:181-188`), and the
member receives a severity flag, not the model's prose (`routes/assessment.js:263`).

### 4.4 Polish and supplement guide

`polish` sends exactly the typed text plus a fixed system prompt
(`routes/polish.js:59-84`) — zero database reads. `supplementDetail` sends the supplement
name plus the neutralised client-supplied profile (`routes/supplement_detail.js:65-84,333`).

---

## 5. Outbound: the provider layer

`utils/aiRouter.js` owns the only network path to a model. Nothing else may dial a
provider, and that is checkable: `completeWithFallback()` is the sole exported call
(`aiRouter.js:926,1050`).

### 5.1 Purpose-keyed chains

The routing table is `AI_ROUTES` (`aiRouter.js:100-189`):

| Purpose | Primary | Declared fallbacks | Line |
|---|---|---|---|
| `assessment` | `openrouter` | `groq` | `:102-112` |
| `chat` | `anthropic` | `openrouter`, `groq` | `:115-140` |
| `polish` | `openai` | `openrouter`, `groq` | `:143-159` |
| `supplementDetail` | `openrouter` | `groq` | `:162-169` |
| `systemDetection` | `groq` | **none** | `:172-175` |
| `priorityFlagging` | `anthropic` | **none** | `:178-188` |

Two purposes are standby-free, for two different reasons worth remembering.
`systemDetection` has a rule-based fallback of its own, so a second vendor adds nothing
(`aiRouter.js:136-139` region). `priorityFlagging` is deliberately single-provider because
its only power is to escalate a member to human review: routing it to a cheap standby would
let a free-tier model decide who gets looked at, and "Anthropic being out of credit is not a
clinical fact about the member" (`aiRouter.js:183-187`).

`AI_DEFAULT_PROVIDER` (`aiRouter.js:86,272-286`) substitutes for the table's default at
**configuration time only**, and the substitution is tagged `viaDefault` on the attempt
record. It is not a runtime rescue: a chain that exhausts does not fall through to
whatever else is configured.

### 5.2 Models and keys

Provider definitions live in `utils/aiProviders.js:68-166`. Env **names** only:

| Provider | Key env | Default model | Wire |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | `deepseek/deepseek-v4-flash` (`:74`) | OpenAI |
| Groq | `GROQ_API_KEY`, `GROQ_MODEL` | `openai/gpt-oss-120b` (`:97`) | OpenAI |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` | `gpt-5.4-nano` (`:115`) | OpenAI |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` (`:134`) | native `/v1/messages`, `x-api-key` (`:136,141`) |
| Llama | `LLAMA_API_KEY`, `LLAMA_MODEL`, `LLAMA_BASE_URL` | none | routed by **no purpose** (`:148-165`) |

`resolveKey()` trims the value and refuses anything shaped like a `.env.example`
placeholder (`your_*_here`) (`aiProviders.js:274-290`), so a template key fails loudly at
routing time instead of dialing out with a literal string.

### 5.3 The wire body

`aiRouter.js:698-743` sends `model`, `messages` (role/content) or, on the Anthropic wire, a
top-level `system` (`:705`), `max_tokens`, `temperature`, `stream: false`, and
`response_format:{type:'json_object'}` when JSON is requested (`:741`). Defaults are 700
tokens and 0.3 temperature (`:642-643`); callers override — chat 700/0.7/45 s
(`routes/chat.js:327-331`), plan generation 16k tokens/0.2/180 s (`routes/recommend.js:135`),
learning ranking 9000/0.2/90 s (`utils/conditionLearning.js:265-267`).

No cookie, no bearer token, no session id and no database credential is on that request.
Authentication to the provider is the provider's own key header.

### 5.4 Timeout, retry, and what a failure looks like

The whole call is bounded by `DEFAULT_TIMEOUT_MS` 15 000 (`:198`) with a
`PRIMARY_BUDGET_FLOOR_MS` of 5 000 (`:205`); `splitTimeout()` divides the budget evenly
across the chain and the last provider keeps the remainder (`:411-415`). JSON mode retries
once without `response_format` on an HTTP 400, OpenAI-wire only (`:811-813`). Error bodies
are read, capped at 600 chars, and their credential-shaped substrings scrubbed before they
are kept (`:769`, `providerErrorDetail()` `:570-591`). Latency is measured after the body is
read, not at headers (`:787-793`). Each attempt records
`{provider, ok, error, latencyMs}` (`:974,978`) and chain exhaustion names every unusable
key (`:935-957`).

Two of these are observability surfaces, because a billing outage is invisible to a
configuration probe: `detectCreditExhausted()` (`:543-550`) recognises the three phrasings
of "valid key, empty account" and sets a **flag**, and `providerHealth()` (`:906`) exposes
the last real outcome per purpose plus `creditBlocked`. That map contains no prompt, reply
or member content — it is two in-memory Maps (`:864-908`), surfaced to admins as the
`ai_provider_billing` row (`routes/admin.js:1939`).

---

## 6. Post-generation: the verification layer

Nothing from a provider reaches a member before this layer runs. It has two halves.

### 6.1 Structure: plans and guides

`groundPlan()` (`utils/planGrounding.js:687`) checks every recommendation against the app's
own evidence registry: a supplement the app has no entry for is dropped, a dose outside
`DOSE_TABLE` (`:509`) is clamped (`clampDosesInProse()` `:1418`, `checkDose()` `:609`), a
citation not in the allowed PMID set is stripped (`verifyCitation()` `:461`), conditions the
member never reported are removed from the rationale (`unreportedClaims()` `:339`), and cure
or certainty language is downgraded (`downgradeAbsoluteClaims()` `:1239`).
`verifyGuide()` runs the same rules over a cached guide document, both before storing and
before serving (`routes/supplement_detail.js:247-256,312,363`), through
`stripIdentifiersDeep()` + `verifyDocumentDeep()` (`planGrounding.js:1003,1753`).
What survives is then re-checked for internal consistency and adapted to history before
shipping (`routes/recommend.js:184-202`). If the model produced nothing usable, the rule
engine answers instead — a degraded plan, never a fabricated one.

### 6.2 Prose: chat, polish, guide text

`verifyProse()` (`planGrounding.js:1716`) walks free text sentence by sentence and removes
invented citations, unsourced statistics in any unit, doses above the published range,
advice to change a named prescription, lab values or conditions the member never reported,
any identity-shaped string the model could not have known, and any benefit claimed for a
product the app has no evidence entry for. `memberName` is the one fact it is allowed to
**write in** (`routes/chat.js:372`).

The product guard is the newest of those, and it exists because hedging was not enough.
`enforceBrandClaims()` (`planGrounding.js:1708`) fires when a sentence pairs one of
`UNVERIFIED_PRODUCT_TERMS` (`:1696`) with a benefit verb (`PRODUCT_BENEFIT` `:1698-1703`) and
replaces the whole sentence with `BRAND_CLAIM_LINE` (`:1705-1706`), which deliberately names
no product so the replacement is itself idempotent. The shape it caught was
"X is clinically proven to improve your vision" shipping as "X is reported to improve your
vision" — `downgradeAbsoluteClaims()` softened the verb but left the claim standing, which
reads to a member like sourced guidance about a product this app has no entry for. Bare
interaction mentions and ordinary food words are false-positive guarded (`:1696` excludes
barley); see section 15.

### 6.3 Typography is a correctness issue, not a cosmetic one

Providers differ in which code points they emit: a Groq model answers with U+2019 and
U+2009 where Anthropic emits ASCII, and every guard in this layer is written
`can'?t` / `doesn'?t` — a curly apostrophe is a word boundary, so an un-normalised reply
silently defeats the guard it should trip. `utils/modelText.js` is therefore the single
fold-to-ASCII seam, applied at the two outward points (`readCompletionText` in
`aiRouter.js`, and the head of `verifyProse`). En dash and em dash are **not** folded:
`DOSE_NUMBER` matches `[-–—]`, `CLAUSE_SPLIT` splits on `[—–-]`, and the app's own
`UNSOURCED_STAT_LINE` contains an em dash — folding those broke the verifier's idempotence
contract and is documented as a deliberate exclusion in `modelText.js`.

---

## 7. Persistence: what is stored and in what state

| Collection | Holds | Encryption | Retention |
|---|---|---|---|
| `AiChatThread` | `messages[{role,text}]` `models/AiChatThread.js:24-27`, `turns[{i,docs,repairs,provider,clean}]` `:43-52`, `title`, `lastText`, `messageCount`, `pinned`, `archived` | **None** — plaintext at rest | No TTL. Auto-archives past 7 active non-pinned threads (`routes/chat.js:440-464`), archive list capped at 100 (`:593-596`), hard `deleteOne` on request (`:635`) |
| `AiChatFeedback` | `vote`, `docIds`, `repairs`, `provider`, `(user,thread,messageIndex)` unique | n/a | No question or answer text is stored, by design: "a second copy of a member's health prose is a second place to leak it" (`models/AiChatFeedback.js:17-19`) |
| `Assessment` | the full health record + `aiResults` | Plaintext | `expiresAt`, 5 calendar years; priority-flagged rows do not expire while under review (`models/Assessment.js:43-51`) |
| `ConditionProposal` | AI-proposed conditions, append-only `verdicts` | n/a | Kept; rejects are a permanent record (`:25-62`) |
| `DynamicCondition` | evidence-gate-published clinical bundles | n/a | Live until retired |
| `AiLearningRun` | counters, watermark, lease only — **no candidate data** (`models/AiLearningRun.js:22-26,46-58`) | n/a | One ledger row |
| `SupplementDetail` | guides keyed under a **profile digest** (`variants.<digest>`) | n/a | Cache |
| `ChatThread` / `ChatMessage` (human support) | sealed ciphertext | E2EE, see 13.3 | n/a |

`turns[].docs` is the audit trail that makes a thumbs-down mean something: it records which
notes the model was shown for that specific reply, so feedback can be attributed to a
retrieval decision rather than to a mood (`AiChatThread.js:29-42`). It is written by the
server, and feedback copies from it, never from the client (`routes/chat.js:505-555`).

The gap this table exposes is real and is restated in section 14: **AI transcripts are the
only health prose in this product that is not encrypted at rest**, while human support chat
is end-to-end encrypted.

---

## 8. Retrieval-augmented generation

The corpus is entirely locally curated and pre-built: `buildCorpus()` concatenates nutrient,
dose, outcome, app and field-observation docs, cached once per process, synchronous and
keyless on purpose (`utils/ragCorpus.js:250-255`). Measured at **168 documents** in this tree.
Its sources are the app's own published content — `supplementEvidenceRegistry.ENTRIES`
(**65 entries**, every PMID re-resolved against NCBI by `npm run eval:citations`),
`planGrounding.DOSE_TABLE`, `appFeatureGuide`, questionnaire labels (`ragCorpus.js:3-6,20-27`)
— plus three `kind: field` notes from the project team's own pharmacy research interview
(`fieldStudyDocs()` `:195-244`, provenance and limits at `:172-193`). **Nothing is fetched from
the open web and nothing is generated by a model** (`:23-27`). Two per-request extras are
added live: the member's own plan rows (`planDocs` `:258`) and currently-published dynamic
conditions (`dynamicConditionDocs` `:287`) (`:258-310`).

The field notes are the only content in the corpus that did not come from the app's own
published text, and they are shaped so they cannot behave like evidence: `pmids: []`,
`nutrients: []`, no figure with a unit, provenance inside the document text, and a
"this is not a population statement / the app cannot verify that brand" clause in every
sentence (`:176-193`). Section 15 covers where that interview went besides the corpus.

Retrieval is BM25, `K1 = 1.4`, `B = 0.75` (`utils/ragRetriever.js:35-36`), IDF
`log(1+(N−d+0.5)/(d+0.5))` (`:106`), title weighted ×3, terms appearing in more than 34 % of
documents discarded as non-discriminative (`:123-126`), curated alias expansion over 20
groups (`:45-65`), and boosts for whole-phrase name matches (×2.4), dose mentions (×1.5),
in-plan (×1.3) and member-reported (×1.12/×1.512) documents (`:234-244`).

Injection is bounded: default 6 notes, hard maximum 12 (`:220`), plus up to 3 forced named
notes (`:257`) and forced *absence* notes for "does it contain X" questions regardless of
score (`:264-271`), inside a 3,200-char budget (`:276`). `referencesBlock()` marks the block
as data and escapes `<` so no document can close its own fence (`:281-308`).

The learned prior multiplies the BM25 score and is itself clamped to 0.4–2.0, so a popular
note can never beat a literal match (`:245-246`).

---

## 9. The self-learning loop

`utils/conditionLearning.js` is armed from boot — `index.js:828` calls `schedule()`, which
first checks `CONDITION_LEARNING === 'false'` (`:481`), runs once after
`BOOT_DELAY_MS` (default 90 s, floor 10 s, `:79`), then every `RUN_INTERVAL_MS` (default
3 600 000 ms, floor 600 000, `:69-71`). Both timers are `unref()`d (`:494,505`).

Only one process may run a cycle: `AiLearningRun.claim()` is an atomic
`findOneAndUpdate` gated on `lockUntil <= now` (`models/AiLearningRun.js:86-105`), released
with a watermark (`:108-130`), with `consecutiveFailures` counting toward the monitor's
critical state. A cycle will not even start unless both `CONDITION_LEARNING_MIN_NEW`
(≥25 new assessments, `:67`) and `CONDITION_LEARNING_MIN_HOURS` (≥24 h since last, `:68`)
are met.

**What a cycle reads** — `Assessment.find({}).select('createdAt symptoms medicalConditions
feelingDescription lifestyleHabits')`, newest first, `CONDITION_LEARNING_SCAN_LIMIT` rows
(default 2 000, clamped 100–5 000) (`conditionLearning.js:372-376`).

**What a cycle sends** — counts, canonical labels, and the top 40 narrative words, inside a
fenced fence neutralised at 6 000 chars (`buildStatsFence()` `:201-210`), under a prompt
heading that states "aggregate statistics (no raw patient data)" (`:213`).
Before counting, `narrativeWords()` strips contact-shaped fragments — emails, URLs,
domains, phone-like digit runs — and discards any token containing a digit, hyphen or `@`
(`:132-146`). **No individual member's health text crosses the network during learning.**
The module header asserts this and the code honours it (`:44-45`).

**What may be published** — the evidence gate (`utils/evidenceGate.js:104-133`) requires at
least one surviving supplement whose evidence passes `citationIsAuthoritative`, is not
`isPrescriptionOrDangerous`, and has a name, reason, dosage and valid priority. A candidate
whose text contains `prescription|dangerous|nothing provable|no supplement survived` is
rejected whole (`:139`); a merely dropped row still publishes, annotated. Near-duplicate
rejection compares `coreWords` against builtins (hard) and live rows (reworded-only)
(`:59-85,179-211`). Accepted bundles go through `DynamicCondition.publishAccepted()`
(`:306`); every verdict — both directions — is appended to `ConditionProposal` with the
reviewer recorded as `Evidence Gate (automated)` (`:309-310,315-342`,
`models/ConditionProposal.js:43-62`).

That reviewer label is honest and is the point of this paragraph: **there is no human
approval in this loop**, and nothing a model invents becomes product unless it can cite an
authoritative source with a well-formed PMID.

---

## 10. Feedback priors: the second learning path

`utils/chatLearning.js` builds a docId → weight map from votes:
`AiChatFeedback.find({createdAt ≥ 90 days ago}).select('docIds vote createdAt').limit(5000)`
(`:36,93-97`), each row signed and decayed by `0.5^(ageDays/30)` (`:59`), requiring at least
2 votes, averaged over `n+3` (a shrinkage term, so one vote cannot move a note much), and
clamped to **[-0.45, +0.6]** (`:73-74`).

**This path makes zero provider calls.** It is arithmetic over the app's own database, run
inside a request, cached 5 minutes (60 s after a failure, keeping the last good map)
(`:34-35,88-107`). Its output is the retrieval multiplier in section 8, and its stats feed
the `ai_chat_grounding` monitor row (`feedbackStats()` `:111-131`).

---

## 11. Fine-tune export: what "train the model" means with API keys

The honest answer is in the header of `eval/exportFineTune.js:3-21`, and it should be read
before anyone expects a training run.

An API key can start a fine-tune job on OpenAI's own models and on nothing else in this
stack: OpenRouter routes to third parties' hosted weights, Groq serves inference on someone
else's chips, and Anthropic does not expose a text-completion fine-tune of Haiku through the
endpoint called here. So the product **does not train the model it queries**. What it does
is produce the supervision such a job would need:

- `npm run eval:fine-tune` (`server/package.json:37`) writes JSONL in OpenAI's chat
  fine-tune shape to `eval/fine-tune/assessment-grounded.jsonl` (`exportFineTune.js:44-45,83-85`).
- Rows are built **offline and deterministically from `eval/baseline-profiles.json` plus
  `eval/field-study-profiles.json` — six synthetic profiles** (`:34,40-41,70`). No database
  read, no member row, no provider call. The two field-study profiles are the interview's
  shape (an older member on maintenance antihypertensives, asking about branded supplements)
  put through the same verifier as the four the authors imagined (`:35-39`; section 15).
- The assistant turn is the **grounded** plan — `enforcePlanConsistency(generateClinicalFallback())`
  passed through `groundPlan()` — not a model draft, because fine-tuning on unverified output
  would teach the exact behaviour this work removes (`:48-51`).
- Any row that still fails `groundingViolations()` is skipped and named in the console
  output (`:53,72-75`). Today all six pass: `npm run eval:fine-tune` reports 6 rows, 0 skipped.
- Nothing is uploaded. There is no `files.create`, no `/v1/files` and no
  `/v1/fine_tuning/jobs` call anywhere in `server/`; the script only prints the manual upload
  target and warns that the OpenRouter, Groq and Anthropic keys cannot consume the file
  (`:87-89`).

So the levers that actually reduce hallucination today are the two in section 6 — better
input and repaired output — and the export is a prepared artifact for a day when the route
sits on a tunable model. There is **no automated training run and no scheduled export**.

---

## 12. Data that deliberately never reaches a model

- **Anything from another member.** A chat turn projects one assessment for one user id
  (`routes/chat.js:265-273`); `IDENTITY_POLICY` instructs the model never to speak of
  another member, a clinician or an admin (`chatIdentity.js:175-186`).
- **Identity and account fields.** Withheld by `chatIdentity.js:26-34`: `email`,
  `phoneNumber`, `dateOfBirth`, `recoveryEmail`, `password*`, every `twoFactor*`,
  `webauthn*`, `chatEncryptionKey`, `subscription*`, `accountRole`, `accountStatus`,
  `lastLogin*`, `currentSessionId`, `sessionVersion`, `medicalReview*`, images.
- **Anything a clinician or admin wrote about the member.** `medicalReview*` and
  `MedicalReviewAudit` are not in any prompt builder.
- **Raw narrative during learning.** Reduced to counts, labels and top words first
  (section 9).
- **Support chat.** The human support channel is end-to-end encrypted; the AI pipeline does
  not read it and the server cannot (section 13.3).
- **Secrets.** Provider keys are read from env at routing time and never serialized into a
  response, a log line, or a provider error message (`aiRouter.js:570-591`).

The `SupplementDetail` guide cache is worth one explicit note here: it is keyed on a
**digest of the profile**, not on a user id (`routes/supplement_detail.js:285`,
`models/SupplementDetail.js:12-26`), so a guide generated for one member's profile shape can
be served to another with the same shape — which is fine because the guide is about the
supplement, and it is what keeps a per-member cache from becoming a store of member-specific
health prose.

---

## 13. System-wide flow outside the AI features

### 13.1 At rest

`User` — argon2id password hash, rehashed on login, stripped at every JSON boundary via
`toJSON.transform` (`models/User.js:460-465,476-494`). `twoFactorSecretEnc` is AES-256-GCM
through `secretBox` (`:194-208`); a legacy plaintext `twoFactorSecret` is still read and
upgraded on use (`:209-215`). `dateOfBirth`, `gender`, `email`, `recoveryEmail`,
`phoneNumber` are plaintext. `lastLoginIp`, `lastLoginUserAgent`, `currentSessionId` are
`select:false` (`:349-389`). Deleting a user cascades assessments, intake, metrics,
subscription requests, AI chat threads and support messages (`:496-555`) — there is no
member-facing data export.

`Session` stores SHA-256 digests of tokens, never the tokens (`models/Session.js:39-53`),
with no clock expiry by design — a session ends by replacement or revocation (`:14-25`).
`PasswordResetToken`, `BackupCode`, `MfaTransaction` all store `hex(sha256)` with TTL indexes
(`PasswordResetToken.js:44`, `BackupCode.js:37,74`, `MfaTransaction.js:55,101`,
`AuthChallenge.js:105`).

`SecurityEvent` has a closed vocabulary and an allowlisted `meta`, so a secret cannot be
smuggled into the event log (`models/SecurityEvent.js:25-74,104-127`).

### 13.2 Key boundaries

| Env name | Protects | Note |
|---|---|---|
| `JWT_SECRET`, `JWT_SECRET_PREVIOUS_KEYS` | token signing | HS256 pinned; deprecated keys verify-only, with acceptance counts (`utils/jwtKeyring.js:55,101-127`) |
| `HEALTH_DATA_KEY` (+ `_PREVIOUS`) | health blobs, wallet keys | dedicated key, `utils/dataKey.js:21-22` |
| `TOTP_ENCRYPTION_KEY` (+ `_PREVIOUS`) | 2FA seed envelopes | production **refuses to boot** without a dedicated key (`utils/secretBox.js:127-134`) |
| `CHAIN_SEAL_KEY` | ledger audit checkpoints | `models/Web3.js:88` |

The documented coupling risk: `JWT_SECRET` historically did signing **and** at-rest
encryption, and the derived fallbacks (`HKDF 'suppliwise/data-at-rest/v1'` in `dataKey.js:41-42`,
`'suppliwise/totp/v1'` in `secretBox.js:37,59`) re-couple them if the dedicated keys are
absent. `rotationSafety()` names the blockers (`jwtKeyring.js:144-167`), and the admin
monitor warns on the health-data-key separation at `routes/admin.js:2100`.

Field-level encryption covers TOTP seeds (`v1.<kid>.<iv>.<tag>.<ct>`, `secretBox.js:22-33`)
and health blobs; transport TLS is optional and configured separately; end-to-end encryption
exists only for support chat. These are three different mechanisms and should not be spoken
of as one.

### 13.3 Support chat — the strongest boundary in the product

Key agreement is ECIES on P-256; the member's browser holds the private half
(`User.chatEncryptionKey`, `models/User.js:232-237`) and the server never does
(`utils/chatKeys.js:43-59,157-189`). Threads store `encryption.version` and per-participant
wrapped key shares (`models/ChatThread.js:11-17,124-129`); each message carries exactly one
of `body` (plaintext, non-encrypted threads) or `cipher` `e1.<iv>.<ct>`
(`models/ChatMessage.js:42-57`), and a sealed thread's preview is empty by construction
(`ChatThread.js:75-84`). `utils/chatEncryption.js` validates **shape, never content**
(`:1-52,65-83`), refuses a plaintext reply into a sealed thread (`:162-169`), and
`sharesForParticipant()` returns only your own blob (`:248-254`). Operators see subject,
category, status and timestamps: "that key is not on this server and never was"
(`routes/adminSupportChats.js:131-141`). `utils/memberPrivacy.js` further replaces the
member with an opaque `Member XXXX` handle derived from the id at the admin read edge
(`:16-38,62-89`).

### 13.4 What leaves the server besides AI traffic

Email via SMTP (`EMAIL_HOST/PORT/USER/PASSWORD/SERVICE/FROM_*`, `utils/email.js:1`), emailed
OTP with a 5-minute TTL (`:14`), recipient addresses masked in logs (`:19-27`). SMS via
`SMS_PROVIDER` = console | textbee | twilio (`utils/sms.js:60-67`, `TWILIO_*`, `TEXTBEE_*`).
Passkeys use `WEBAUTHN_RP_ID`/`WEBAUTHN_RP_ORIGIN` and a random opaque `webauthnUserId`
rather than the email (`User.js:216-231`).

### 13.5 The blockchain ledger is public

This is the sharpest boundary in the system and the easiest to understate. Anchors publish
into `Block.txs[].data` (`models/Web3.js:42-43`), which is unencrypted, so what lands there
is public forever:

- health anchors publish only `digest`, `assessmentCount`, `intakeCount`
  (`routes/web3/data.js:105-127`);
- recommendation anchors publish `assessmentId`, `logicVersion`, `combinedHash` (`:411-413`);
- consent grant/revoke transactions (`:329,366`) and storage pins (`:256`);
- staking amounts and wallet addresses (`routes/web3/engine.js:313,328`).

Digests for private payloads are computed by the ledger itself and are never
caller-supplied (`engine.js:100-115`), and a secret-only anchor is marked
`digestCovers: 'private'` (`Web3.js:37-51`). Explorer reads are plan-gated
(`routes/web3/chain.js:73-79`, `guards.js:37-63`), but gating the read path does not gate
the chain. The consequence for the AI features is worth stating plainly: `bc_ai_proof`
(`routes/admin.js:2464`) makes a recommendation verifiable **publicly by hash**, so an
`assessmentId` in an anchor is a permanent public identifier of the fact that some
assessment exists.

---

## 14. Open gaps and operator obligations

These are findings, not todos dressed as findings.

1. **No AI kill switch.** There is no `AI_ENABLED` and no per-purpose enable flag anywhere
   in `server/` — grep finds only `TLS_ENABLED`. The only off-switch in the AI layer is
   `CONDITION_LEARNING=false` for the learning loop (`conditionLearning.js:461,481`), plus
   the subscription gate on chat. To stop AI generation in production today, an operator
   either removes a provider key and restarts, or blocks the route at the proxy. If a
   regulatory or cost event ever requires turning the AI off in seconds, this is the gap to
   close first.
2. **AI transcripts are plaintext at rest** (`AiChatThread.messages`, section 7) while human
   support chat is end-to-end encrypted and assessments carry a 5-year expiry. The asymmetry
   is unexplained by any threat model; the member-visible text is the same category of
   disclosure.
3. **AI plan generation is currently degraded by provider capacity, not by code.**
   Measured 2026-10-20: the assessment prompt is ~8 128 tokens and Groq's free tier caps at
   8 000 tokens/minute, so it answers HTTP 413 and plans fall back to the rule engine
   (`securityAudit.js` `liveAssessment`). Chat fits and works. The fix is account-side.
4. **Provider funding, not code, is the binding constraint.** Recorded 2026-10-20: the
   Anthropic, OpenRouter and OpenAI accounts were all reporting a credit outage
   (`utils/securityAudit.js`, `providerChain`). Groq's free tier was the only funded provider
   in that reading, and it can carry chat but not `assessment` (its prompt exceeds the free
   tier), `polish` (primary is OpenAI) or `supplementDetail` (primary is OpenRouter). Today's
   state is not something this document can assert — read the `ai_provider_billing` row in
   the admin Security Center, which exists so that answer is a number on a screen rather
   than a support ticket. Fund the primaries or move each purpose's primary onto a funded
   account; the chains in section 5.1 only work if at least one provider in each answers.
5. **`supplementDetail` accepts a client-supplied profile** (section 3). It is neutralised
   and it leaks nothing, but it means the guide cache can be poisoned with fabricated
   profile shapes by any authenticated member.
6. **`priorityFlagging` fails closed on a credit outage** — by design (section 5.1). If
   Anthropic is unfunded, no AI second opinion is added, and the rule engine alone decides
   escalation. That is the safe direction, but it is a silent reduction in clinical safety
   net and should be watched as such, not just tolerated.
7. **No rate limit is scoped to a plan tier.** `aiLimiter` and `recommendLimiter` are
   IP-scoped; a member on a paid plan and a member on a free plan consume the same provider
   budget per route. Entitlement gating exists only on chat.
8. **The deployed stack is not this tree.** Production on `:5000` runs `Main-1`, whose chat
   route has no RAG, no identity projection, no `verifyProse` and no `turns` audit trail, and
   whose `AiChatThread` is `{role,text}` only. Every control in sections 6, 8, 9 and 10 is
   `Main-3-F` only until it is deployed.

---

## 15. First-party research input: the pharmacy interview

This project's own research team recorded an interview at a community pharmacy (October 2026;
extract `pharmacy_audio_extracted_data.csv`, seven columns — speaker role, affiliation,
target demographic, age bracket, category, item name, notes). Eleven data rows: one interviewer
prompt, one staffing/demographic answer, one refill-policy answer, three maintenance
antihypertensives (amlodipine, losartan, telmisartan) and five branded supplements
(Santonn Plus, Santonn Plus Gold, Eyeberry, Liveraid, barley powder/capsule). The respondent
is **one pharmacy staff member at one shop**; the interviewee states customer names cannot be
disclosed, so there are **no patient identifiers** anywhere in it. The raw file lives outside
this repository and no code reads it — what entered the product is a hand-written
distillation, which is what makes it auditable.

It is now a bounded input to three places. Each was chosen so the interview can improve
accuracy without ever being able to masquerade as clinical evidence.

### 15.1 Retrieval notes (`utils/ragCorpus.js:195-244`)

Three `kind: field` documents join the corpus (section 8): what members actually buy as
maintenance therapy, which supplement brands get asked for, and who the app was studied
with. The shape is the safety property, and every constraint is pinned by a test:

- `pmids: []` and `nutrients: []`. `verifyCitation()` (`planGrounding.js:461`) only lets a
  reply keep a PMID that belongs to the nutrient named next to it, and `groundPlan()` only
  lets a row survive for a supplement with an evidence entry — so a field note can neither
  smuggle a citation into a sentence nor a supplement into a plan.
- **No figure with a unit.** A test asserts the field texts contain nothing matching
  `\d+\s?(mg|mcg|g|IU|%)`, so retrieval cannot hand a model a number to repeat.
- **Provenance and limits ride inside the text**, not in a side field: each note names the
  interview and says what it is not — "not a clinical claim", "no supplement replaces a
  prescribed antihypertensive", "it is not a statement about any individual member's risk".
  A retrieved note reads to a member like the app's own guidance, so a note that names a
  brand has to say in the same breath that the app cannot verify that brand.
- Composition is never guessed at. The interview recorded names customers ask for, not what
  is in them, and the note refuses to bridge that gap.

### 15.2 Guard vocabulary (`utils/planGrounding.js:164-175, 1696-1712`)

`telmisartan` was missing from `PRESCRIPTION_DRUG_NAMES`. Two guards read that list, and a
drug absent from it is invisible to both: the fabricated-patient-fact guard only catches
"your telmisartan" / "since you take telmisartan" if it recognises the word as a medication
at all, and `enforceMedicationSafety` only refuses to advise stopping a pill it can name.
Adding the drug the interview actually observed closes both for a medicine these members
take. Neither guard fires on a bare mention ("safe alongside telmisartan"), which is correct
and is now a test — naming a drug in a general interaction sentence is not a claim about the
member.

The same widening exposed a production defect. `enforceBrandClaims()` is described in
section 6.2: a benefit claim about a product with no evidence entry used to survive as a
*hedge*, which launders an unverifiable claim into something that reads sourced. It is now
replaced outright.

### 15.3 What the interview did **not** become

- It did not become a clinical claim. Nothing from it entered
  `supplementEvidenceRegistry.ENTRIES`, so no plan row, dose or citation in the product
  rests on it.
- It cannot feed `conditionLearning`, which publishes on PMID-bearing authoritative
  citations (`evidenceGate.js:104-133`); an interview tally has no PMID and the gate would —
  correctly — reject it.
- The raw file is never pasted into a provider prompt. What a provider may see of this
  research is at most one 3,200-char-capped retrieval note (section 8) that contains no
  person, no patient and no number.
- No member is identified by it. The field-study profiles of 15.4 are synthetic; nothing in
  them is a real person, and the `source` string on each profile says so.

### 15.4 Accuracy profiles (`eval/field-study-profiles.json`)

Two synthetic members shaped by the interview — a 58F on telmisartan asking about barley
capsules, a 67M on amlodipine + losartan + atorvastatin asking about Santonn Plus Gold and
Eyeberry — using only vocabularies already present in `baseline-profiles.json`. They widen
three gates rather than documenting a finding: `npm run eval:ai` (6 profiles), the
shipped-baseline sweep inside `npm run eval:hallucination` (both must come out of the app's
own rule engine with **zero** prose repairs and zero grounding violations — they do), and
`npm run eval:fine-tune` (6 supervision rows, 0 skipped). That is the difference between
research and a product change: the accuracy gates now measure the member this interview
described, and a fine-tune dataset — if one is ever run — contains that shape too.

`Test File/field-study.test.js` (16/16) pins 15.1–15.4: the evidence-free shape of the field
docs, provenance printing with them, the brand question retrieving the brand note, the
possessive-drug repair, the false-positive guards, and idempotence of the brand replacement.

---

## 16. Which gate proves which claim

| Claim in this document | Gate |
|---|---|
| Section 4 allowlists are real, not vibes | `Test File/ai-routing.test.js`, prose-grounding tests on `chatIdentity` |
| Section 6 leaves a correct refusal alone | `npm run eval:hallucination` — 1 198 adversarial cases, 0 violations, plus an idempotence sweep (`eval/hallucinationAudit.js`) |
| Section 15's research input stays bounded | `Test File/field-study.test.js` — 16/16: no evidence, no dose, provenance, retrieval, guard vocabulary, false positives, idempotence |
| Section 6's typography seam holds | `Test File/model-text.test.js` (fold set pinned, en/em dashes preserved, double-normalisation a no-op) |
| Section 8's retrieval answers correctly | `npm run eval:chat` — offline, per-category floor of 90 %, needs no network or keys; `npm run eval:chat:live` asks the routed model the same questions and prints RAW beside SHIPPED (`eval/chatAccuracy.js`) |
| Section 4.2's plan output is grounded | `npm run eval:ai` / `:live` (`eval/aiBenchmark.js`) |
| Every PMID in the corpus resolves | `npm run eval:citations` (`eval/citationAudit.js`) |
| Section 11's dataset is supervision, not noise | `npm run eval:fine-tune` skips any row the verifier rejects |
| Sections 5, 7, 13 hold in the app itself | `npm run check` (347 files) and `npm test` in `server/`; `npm test`, lint and build in `my-react-app/` |

A discipline goes with these gates: when a member reports a wrong AI answer, add it as a
case **before** tuning retrieval or a scorer. A fix no case pins is a fix the next tuning
pass undoes.

---

## 17. Key files

| Path | Owns |
|---|---|
| `server/utils/aiRouter.js` | the only outbound provider path; chains, budget, attempt records, `providerHealth()` |
| `server/utils/aiProviders.js` | provider table: keys, model ids, wires, probes |
| `server/utils/modelText.js` | the ASCII fold seam (and what it refuses to fold) |
| `server/utils/assessmentPrompt.js` | what a plan prompt contains |
| `server/utils/memberHistory.js` | how a member's own past reaches a prompt |
| `server/utils/chatIdentity.js` | the allowlist that decides what the assistant knows about a member |
| `server/utils/ragCorpus.js`, `ragRetriever.js` | curated notes and BM25 retrieval |
| `server/utils/chatLearning.js` | vote → retrieval priors |
| `server/utils/conditionLearning.js`, `evidenceGate.js` | the scheduled learning cycle and what it may publish |
| `server/utils/planGrounding.js` | post-generation verification, plans and prose |
| `server/utils/supplementEvidenceRegistry.js` | the evidence the verifier trusts |
| `server/models/AiChatThread.js`, `AiChatFeedback.js`, `AiLearningRun.js`, `ConditionProposal.js`, `DynamicCondition.js` | AI state at rest |
| `server/eval/` | the gates in section 16 |
| `server/routes/chat.js`, `polish.js`, `supplement_detail.js`, `recommend.js`, `assessment.js`, `admin.js` | the inbound surfaces |
