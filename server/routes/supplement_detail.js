/**
 * The guide behind "Tap for details".
 *
 * WHY THE STORE IS NOT OPTIONAL
 * -----------------------------
 * This writes a long clinical guide through a paid provider. This route used to
 * store ONLY the non-personalized guide, so every tap on a personalised plan —
 * which is what the recommendations screen always sends — spent a fresh
 * generation. The most-tapped button in the product was the most expensive one
 * to press, and its cost was invisible because it worked.
 *
 * So the store (utils/supplementGuideStore.js) is what makes this route cheap,
 * and it owns the three things that are easy to get wrong:
 *
 *   1. IDENTITY IS PART OF THE KEY. A personalised guide is only valid for the
 *      profile it was written from, so the reader's profile digest keys memory,
 *      disk AND deduplication. The old dedupe key was the supplement name alone,
 *      which is how one reader's health content ended up in another reader's
 *      panel — a privacy failure, not a cache miss.
 *   2. THE DOCUMENT IS BOUNDED. Variants are capped and evicted by the store.
 *   3. STORAGE IS NEVER LOAD-BEARING. A database that is slow, down or full
 *      costs tokens, not a feature — so a failed write is logged and the guide
 *      is still returned.
 *
 * The generation budget (GENERATION_TIMEOUT_MS) is the fourth part of the same
 * decision and lives in the store beside the TTL. It was 20 s here against a
 * measured 8 s–50 s (median ~30 s), so a perfectly healthy provider was reported
 * as a failure often enough that this panel read as broken.
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { dedupe } = require('../utils/cache');
const { completeWithFallback } = require('../utils/aiRouter');
const {
  neutralize, neutralizeList, fenceData, GUARDRAIL_CLAUSE,
} = require('../utils/aiGuardrails');
const { registeredEvidence } = require('../utils/supplementEvidenceRegistry');
const {
  stripIdentifiersDeep, verifyDocumentDeep, describeProseRepairs, buildConversationContext, doseEntry,
} = require('../utils/planGrounding');
const {
  GENERATION_TIMEOUT_MS,
  memoryKey,
  profileKey: guideProfileKey,
  readGuide,
  storeGuide,
} = require('../utils/supplementGuideStore');

/**
 * Build the patient profile string the prompt is written from.
 *
 * This is the ONLY input that makes a guide personalised, and it is also what
 * the store keys on — `guideProfileKey` digests this exact string. That coupling
 * is deliberate and load-bearing: the two are canonicalised by the same
 * function, so a field added here cannot silently be forgotten in the key and
 * start paying for a guide the database already holds.
 *
 * Returns null when there is nothing personal to say, which selects the generic
 * guide rather than storing a personalised copy of a generic answer.
 *
 * @param {object|null} ctx
 * @returns {string|null}
 */
function buildPatientProfile(ctx) {
  if (!ctx) return null;
  // Every field below can arrive from the request body, so it is untrusted:
  // neutralize() strips delimiter/injection tokens before interpolation and
  // the result travels inside a fenced, banner-labelled data block.
  const n = (v, max = 500) => neutralize(v, { maxLength: max });
  const list = (v) => neutralizeList(v, { maxLength: 120 }).join(', ');
  const lines = [];
  if (ctx.age && ctx.gender) lines.push(`Patient: ${Number(ctx.age) || 0}-year-old ${n(String(ctx.gender), 40)}`);
  if (ctx.symptoms?.length)  lines.push(`Symptoms: ${list(ctx.symptoms)}`);
  if (ctx.goals?.length)     lines.push(`Health Goals: ${list(ctx.goals)}`);
  if (ctx.conditions?.length) lines.push(`Medical Conditions: ${list(ctx.conditions)}`);
  if (ctx.allergies)         lines.push(`Allergies: ${n(ctx.allergies)}`);
  if (ctx.lifestyle?.length) lines.push(`Lifestyle Factors: ${list(ctx.lifestyle)}`);
  if (ctx.diet)              lines.push(`Diet Type: ${n(ctx.diet, 80)}`);
  if (ctx.pregnancyStatus && ctx.pregnancyStatus !== 'Not applicable')
    lines.push(`Pregnancy/Breastfeeding: ${n(ctx.pregnancyStatus, 40)}`);
  if (ctx.recommendationReason) lines.push(`Why recommended: ${n(ctx.recommendationReason)}`);
  return lines.length > 0 ? fenceData('PATIENT PROFILE', lines.join('\n')) : null;
}

/**
 * The facts this guide may attribute to its reader.
 *
 * `context` arrives from the browser, so it is not trusted as a source of truth:
 * it is neutralized before it reaches the prompt and the cache key digests that
 * neutralized copy. It is still the best available statement of what this reader
 * said about themselves, and the prose verifier only asks one question of it —
 * "did the model claim something BEYOND this?". A guide that answers yes is
 * stored and re-shown on every later tap of this profile, so the reader's own
 * words are what the check has to be calibrated against, and the same fenced,
 * neutralized string the model saw is what the model is judged by.
 */
function buildProseContext(ctx, patientProfile) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  return buildConversationContext({
    symptoms: arr(c.symptoms),
    healthGoals: arr(c.goals),
    medicalConditions: arr(c.conditions),
    lifestyleHabits: arr(c.lifestyle),
    allergies: c.allergies,
    dietType: c.diet,
    pregnancyStatus: c.pregnancyStatus,
    feelingDescription: c.recommendationReason,
  }, patientProfile || '');
}

/** The personalized prompt. Hoisted so it is one string, not rebuilt per request. */
const PERSONALIZED_PROMPT = (name, profile) => `You are an expert clinical nutritionist and pharmacologist. A patient has been recommended "${name}" based on their health assessment. Write a detailed, personalized supplement guide tailored specifically to this patient.

${evidenceBlock(name)}

${profile}

Your response must explain:
1. What this supplement is and why this specific form was chosen
2. Why it was recommended FOR THIS PATIENT based on their profile
3. Expected benefits relevant to their specific symptoms and goals
4. How to take it — with any absorption tips or inhibitors relevant to their diet/lifestyle
5. Safety considerations specific to their conditions, allergies, or lifestyle factors

Respond with ONLY valid JSON, no markdown, no code fences:
{
  "name": "Full supplement name with form",
  "overview": "2-3 sentences explaining what this supplement is AND why it was specifically recommended for this patient based on their profile. Reference their symptoms or goals directly.",
  "keyBenefits": [
    {
      "title": "Benefit title directly relevant to this patient",
      "description": "1-2 sentences explaining this benefit in the context of this patient's specific symptoms, goals, or conditions."
    }
  ],
  "howToTake": [
    {
      "title": "Instruction title (e.g. Best Time, Absorption Tips, Avoid With, Dosage)",
      "description": "Specific instruction. Note any interactions with their diet type, lifestyle habits, or conditions where relevant."
    }
  ],
  "considerations": [
    "Safety note tailored to this patient's profile — reference their conditions, allergies, or lifestyle factors where applicable."
  ],
  "availability": "1-2 sentences about the forms this supplement commonly comes in (capsule, softgel, powder, liquid). Do not name brands, products or prices.",
  "disclaimer": "Always consult a licensed healthcare professional before starting any supplement regimen. This information is for educational purposes only."
}

Rules:
- keyBenefits: 3-5 items, each directly tied to this patient's symptoms or goals
- howToTake: 2-4 items, note any diet/lifestyle interactions
- considerations: 2-4 notes, flag anything relevant to their conditions or allergies
- Use possibility language ("may", "evidence suggests") — never diagnose
- Never tell this patient to stop, skip, lower or replace anything a clinician prescribes, and never present a supplement as standing in for a prescription. Where their medication is involved, the only correct sentence is that the prescriber decides.
- Be specific — no generic filler. Every sentence should feel written for this patient.`;

/** The generic prompt, for a request that carries no profile. */
const GENERIC_PROMPT = (name) => `You are an expert clinical nutritionist and pharmacologist. Write a detailed, accurate supplement information guide for: "${name}"

${evidenceBlock(name)}

Respond with ONLY valid JSON, no markdown, no code fences:
{
  "name": "Full supplement name with form",
  "overview": "2-3 sentence paragraph describing what this supplement is, its form/type, and why it is used.",
  "keyBenefits": [
    {
      "title": "Benefit title",
      "description": "1-2 sentence explanation with clinical context."
    }
  ],
  "howToTake": [
    {
      "title": "Instruction title",
      "description": "Specific, actionable instruction."
    }
  ],
  "considerations": [
    "Safety consideration as a plain string."
  ],
  "availability": "1-2 sentences about the forms it commonly comes in. Do not name brands, products or prices.",
  "disclaimer": "Always consult a licensed healthcare professional before starting any supplement regimen. This information is for educational purposes only."
}

Rules:
- keyBenefits: 3-5 items
- howToTake: 2-4 items
- considerations: 2-4 notes
- Use possibility language — never make absolute claims
- Never tell the reader to stop, skip, lower or replace anything a clinician prescribes, and never present a supplement as standing in for a prescription
- Be specific and clinically accurate`;

/**
 * The one piece of evidence this guide is allowed to stand behind.
 *
 * A supplement guide is about a single named nutrient, so unlike the assessment
 * prompt it does not need the whole registry in front of it — it needs its own
 * line, and the instruction that nothing else counts. That keeps the anti-
 * hallucination guard cheap on a route that already writes 2000 tokens per tap.
 */
function evidenceBlock(name) {
  // The dosing line rides along with the citation line because it is the same
  // kind of fact: the app already publishes ONE amount per nutrient, and the
  // model has no way to know it. Asked for "how to take it" without that line,
  // the guide invents a number, and unlike an invented PMID an invented dose is
  // not something the reader can check before they swallow it.
  const dose = doseEntry(name);
  const doseLine = dose ? `

## DOSING — NON-NEGOTIABLE
The only amount this app publishes for "${name}" is: ${dose.standard}. Its safety ceiling is ${dose.ceiling.value} ${dose.ceiling.unit}. Never tell the reader to take more than that, and never present a different figure as the usual or studied dose. A number you were not given here is a number you do not have.` : '';
  return `## EVIDENCE — NON-NEGOTIABLE
The only evidence statement this app will publish for "${name}" is this curated line, which a human checked at PubMed:
"${registeredEvidence(name)}"
Copy it word for word if you need to make an evidence claim, or say nothing about evidence at all. NEVER write any other PMID, DOI, journal title, author, publication year, named trial, sample size, percentage or study URL anywhere in this guide. A citation you were not given above is not knowledge you have: it is the app's knowledge gap, and inventing a source to fill it is a clinical error — this guide is stored and shown to every later reader of this profile, so an invented citation does not just mislead one person.${doseLine}`;
}

/**
 * Verify a generated guide against everything the app cannot vouch for.
 *
 * Runs BEFORE the write, not before the response, and that order is the whole
 * point: this route stores first so the next tap is free, so an unverified PMID
 * that reaches `storeGuide` is served from cache to every later reader of that
 * name+profile — a fabrication becomes permanent infrastructure rather than one
 * bad answer. Fields are walked recursively because the guide is nested
 * (keyBenefits[].description, considerations[]) and picking fields by name at the
 * call site is how one of them gets forgotten.
 *
 * Sentences are never removed, only what is wrong inside them: the advice may be
 * sound even when the number bolted onto it is not, and this route has no way to
 * tell which. Punctuation left behind by a removal is repaired for the same
 * reason it is repaired in chat — a reader who spots "(PMID: )" knows something
 * was hidden from them.
 *
 * The identifier pass alone was not enough, because an invented citation is the
 * ONE hallucination a reader can spot. The others are invisible and therefore
 * durable: a guide that says "take 10,000 IU daily", "proven to cure fatigue",
 * "reduces symptoms by 70%", or "because of your endometriosis" for a reader who
 * never named one reads like expertise. So this runs the same prose verifier the
 * plan rows and chat replies run, over the whole nested document, before the
 * write — and again on the way out of the cache, so a guide stored by the older,
 * identifier-only version gets corrected for its next reader instead of being
 * grandfathered. The pass is idempotent, which is what makes re-verifying a
 * cached copy safe rather than a slow degradation of the text.
 */
function verifyGuide(detail, proseCtx) {
  const { value, removed } = stripIdentifiersDeep(detail);
  if (removed.length) {
    console.warn(`[supplement_detail] removed ${removed.length} unverifiable identifier(s): ${removed.join(', ')}`);
  }
  const verified = verifyDocumentDeep(value, { ctx: proseCtx });
  if (verified.repairs.length) {
    console.warn(`[supplement_detail] ${describeProseRepairs(verified.repairs)}`);
  }
  return verified.value;
}

/**
 * Store a generated guide, never letting storage failure cost the reader theirs.
 *
 * The reader is holding a guide the provider has already paid for. A full disk or
 * an unreachable database means the NEXT tap pays again — an expensive
 * regression — but failing here would throw away the answer that is already in
 * hand, which is strictly worse. So the write is best-effort and reported.
 */
async function storeQuietly(args) {
  try {
    await storeGuide(args);
  } catch (error) {
    console.error('[supplement_detail] guide stored in memory only:', error.message);
  }
}

router.post('/', protect, async (req, res) => {
  const { supplementName, context } = req.body;

  if (!supplementName || typeof supplementName !== 'string' || supplementName.length > 200) {
    return res.status(400).json({ message: 'Invalid supplement name.' });
  }

  const patientProfile = buildPatientProfile(context);
  const proseCtx = buildProseContext(context, patientProfile);
  // null for the generic guide, and the digest of the reader's profile otherwise.
  const key = guideProfileKey(patientProfile);
  const nameKey = supplementName.toLowerCase().trim();
  // The cache stays keyed on nameKey (the client sends a name from OUR plan), but
  // the prompt only ever sees the neutralised copy — a crafted name cannot break
  // out of its quotes or inject role tokens into the instruction text.
  const safeName = neutralize(supplementName, { maxLength: 200 });

  // ── 1. Storage, before anything that can spend money ──────────────────────
  // Memory, then Mongo. This is the whole cost argument for the feature: past
  // the first tap of one supplement by one reader, this is a read.
  //
  // A read that cannot be answered is treated as a MISS. That costs one
  // regeneration in the case where the guide actually exists — the thing this
  // endpoint exists to avoid — but the alternative was an unguarded await in
  // front of the route's only try/catch, so every storage hiccup rejected the
  // handler, nobody answered the request, and the reader's button simply hung.
  // Logged, because a double charge should be visible rather than silent.
  let stored = null;
  try {
    stored = await readGuide({ nameKey, profileKey: key });
  } catch (error) {
    console.error('[supplement_detail] guide cache unreadable:', error.message);
  }
  // Re-verified on the way out, not only on the way in: a guide stored by the
  // identifier-only version of this route is still being served today, and the
  // prose rules written since then should apply to it. Idempotence is what makes
  // this second trip correct instead of a fresh edit of an already-edited text.
  if (stored) return res.json({ ...verifyGuide(stored, proseCtx), cached: true });

  // ── 2. One generation per reader per supplement, however many taps ────────
  // The key carries the profile digest. Keyed on the supplement name alone, two
  // readers tapping at once shared one guide — correct for a generic guide,
  // a health-privacy breach for a personalised one.
  const inflightKey = `supplement-ai:${memoryKey(nameKey, key)}`;

  try {
    const outcome = await dedupe(inflightKey, async () => {
      // Re-read inside the deduplicated call. Between the read above and here,
      // an identical request can have finished and stored, and generating anyway
      // would charge twice for one guide.
      const raced = await readGuide({ nameKey, profileKey: key });
      if (raced) return { detail: verifyGuide(raced, proseCtx), cached: true };

      // Provider, model, key AND fallback all come from the routing table. This
      // used to resolve a single target and hand-roll its own `fetch`, so a
      // provider that could not answer failed the whole request instead of
      // trying the next one in the chain — and it re-implemented the JSON
      // extraction the router already owns.
      const completion = await completeWithFallback('supplementDetail', {
        system:
          'You are an expert clinical nutritionist. Always respond with valid JSON only — '
          + 'no markdown, no code fences, no extra text. '
          + GUARDRAIL_CLAUSE,
        user: patientProfile
          ? PERSONALIZED_PROMPT(safeName, patientProfile)
          : GENERIC_PROMPT(safeName),
        maxTokens: 2000,
        temperature: 0.3,
        timeoutMs: GENERATION_TIMEOUT_MS,
        json: true,
      });

      // `completeWithFallback` never throws — a missing key, a rejected key, a
      // timeout and an unparseable reply all arrive as `{ ok: false }`. So the
      // distinction the reader needs has to be recovered from the message.
      if (!completion.ok) {
        // Name every provider tried and why. "AI service error" on its own is
        // what let a dead key look like a flaky one.
        console.error(
          `[supplement_detail] no provider answered: ${JSON.stringify(completion.attempts || [])}`,
        );
        const failure = new Error(completion.error || 'AI service unavailable');
        // A timeout is not a broken service, and the reader can act on one of
        // those and not the other. The router reports an abort in its message.
        failure.timedOut = /timed out|abort/i.test(String(completion.error || ''));
        throw failure;
      }

      const detail = verifyGuide(completion.data, proseCtx);
      if (!detail || typeof detail !== 'object') {
        throw new Error('Could not parse supplement details');
      }

      // A guide that hit the token ceiling is a half guide. It can still parse —
      // the router's JSON extractor closes the last balanced object — and this
      // route caches aggressively, so storing it would serve the same truncated
      // panel to every later tap by this reader for this supplement. Return what
      // we have, but write down nothing: the next tap regenerates.
      if (completion.truncated) {
        console.warn('[supplement_detail] provider stopped at max_tokens; serving this guide uncached');
        return { detail, cached: false, uncached: true };
      }

      // Write it down BEFORE answering. If the process dies mid-response the
      // guide still exists, so the retry is free — the opposite order charges
      // twice for a guide the reader already paid for.
      await storeQuietly({ nameKey, supplementName, detail, profileKey: key });

      return { detail, cached: false };
    });

    // `uncached` is forwarded so the browser does not do in a session what the
    // server just refused to do persistently: keep a half guide and re-show it on
    // every tap. `cached: true` marks a stored hit and is never combined with it.
    return res.json(outcome.cached
      ? { ...outcome.detail, cached: true }
      : (outcome.uncached ? { ...outcome.detail, uncached: true } : outcome.detail));
  } catch (err) {
    const timedOut = err.timedOut === true || err.name === 'AbortError';
    console.error(`Supplement detail ${timedOut ? 'timeout' : 'error'}:`, err.message);

    // `retryable` is what lets the browser show these instead of swallowing them
    // behind its generic 5xx copy — a reader told "something went wrong on our
    // end" cannot tell a provider outage from their own connection, and cannot
    // act on either. The message is reader-facing on purpose: no provider name,
    // no key, no stack.
    return res.status(502).json({
      message: timedOut
        ? 'Writing this guide timed out. Please try again.'
        : 'We could not write this guide right now. Please try again.',
      retryable: true,
    });
  }
});

module.exports = router;
// Exported for the tests: these two are the whole anti-hallucination contract of
// this route, and pinning them is cheaper than standing up a stubbed provider and
// a Mongo write to prove a branch inside the handler.
module.exports.evidenceBlock = evidenceBlock;
module.exports.verifyGuide = verifyGuide;
