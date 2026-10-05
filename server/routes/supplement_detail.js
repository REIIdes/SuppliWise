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
  const lines = [];
  if (ctx.age && ctx.gender) lines.push(`Patient: ${ctx.age}-year-old ${ctx.gender}`);
  if (ctx.symptoms?.length)  lines.push(`Symptoms: ${ctx.symptoms.join(', ')}`);
  if (ctx.goals?.length)     lines.push(`Health Goals: ${ctx.goals.join(', ')}`);
  if (ctx.conditions?.length) lines.push(`Medical Conditions: ${ctx.conditions.join(', ')}`);
  if (ctx.allergies)         lines.push(`Allergies: ${ctx.allergies}`);
  if (ctx.lifestyle?.length) lines.push(`Lifestyle Factors: ${ctx.lifestyle.join(', ')}`);
  if (ctx.diet)              lines.push(`Diet Type: ${ctx.diet}`);
  if (ctx.pregnancyStatus && ctx.pregnancyStatus !== 'Not applicable')
    lines.push(`Pregnancy/Breastfeeding: ${ctx.pregnancyStatus}`);
  if (ctx.recommendationReason) lines.push(`Why recommended: ${ctx.recommendationReason}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

/** The personalized prompt. Hoisted so it is one string, not rebuilt per request. */
const PERSONALIZED_PROMPT = (name, profile) => `You are an expert clinical nutritionist and pharmacologist. A patient has been recommended "${name}" based on their health assessment. Write a detailed, personalized supplement guide tailored specifically to this patient.

PATIENT PROFILE:
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
  "availability": "1-2 sentences about common forms available (capsule, softgel, powder, etc.) and brand examples in the Philippines or globally.",
  "disclaimer": "Always consult a licensed healthcare professional before starting any supplement regimen. This information is for educational purposes only."
}

Rules:
- keyBenefits: 3-5 items, each directly tied to this patient's symptoms or goals
- howToTake: 2-4 items, note any diet/lifestyle interactions
- considerations: 2-4 notes, flag anything relevant to their conditions or allergies
- Use possibility language ("may", "evidence suggests") — never diagnose
- Be specific — no generic filler. Every sentence should feel written for this patient.`;

/** The generic prompt, for a request that carries no profile. */
const GENERIC_PROMPT = (name) => `You are an expert clinical nutritionist and pharmacologist. Write a detailed, accurate supplement information guide for: "${name}"

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
  "availability": "1-2 sentences about common forms and brand examples in the Philippines or globally.",
  "disclaimer": "Always consult a licensed healthcare professional before starting any supplement regimen. This information is for educational purposes only."
}

Rules:
- keyBenefits: 3-5 items
- howToTake: 2-4 items
- considerations: 2-4 notes
- Use possibility language — never make absolute claims
- Be specific and clinically accurate`;

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
  // null for the generic guide, and the digest of the reader's profile otherwise.
  const key = guideProfileKey(patientProfile);
  const nameKey = supplementName.toLowerCase().trim();

  // ── 1. Storage, before anything that can spend money ──────────────────────
  // Memory, then Mongo. This is the whole cost argument for the feature: past
  // the first tap of one supplement by one reader, this is a read.
  const stored = await readGuide({ nameKey, profileKey: key });
  if (stored) return res.json({ ...stored, cached: true });

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
      if (raced) return { detail: raced, cached: true };

      // Provider, model, key AND fallback all come from the routing table. This
      // used to resolve a single target and hand-roll its own `fetch`, so a
      // provider that could not answer failed the whole request instead of
      // trying the next one in the chain — and it re-implemented the JSON
      // extraction the router already owns.
      const completion = await completeWithFallback('supplementDetail', {
        system:
          'You are an expert clinical nutritionist. Always respond with valid JSON only — '
          + 'no markdown, no code fences, no extra text.',
        user: patientProfile
          ? PERSONALIZED_PROMPT(supplementName, patientProfile)
          : GENERIC_PROMPT(supplementName),
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

      const detail = completion.data;
      if (!detail || typeof detail !== 'object') {
        throw new Error('Could not parse supplement details');
      }

      // Write it down BEFORE answering. If the process dies mid-response the
      // guide still exists, so the retry is free — the opposite order charges
      // twice for a guide the reader already paid for.
      await storeQuietly({ nameKey, supplementName, detail, profileKey: key });

      return { detail, cached: false };
    });

    return res.json(outcome.cached ? { ...outcome.detail, cached: true } : outcome.detail);
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
