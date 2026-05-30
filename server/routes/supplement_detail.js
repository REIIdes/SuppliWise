const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');

const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

router.post('/', protect, async (req, res) => {
  const { supplementName, context } = req.body;

  if (!supplementName || typeof supplementName !== 'string' || supplementName.length > 200) {
    return res.status(400).json({ message: 'Invalid supplement name.' });
  }

  // Build a concise patient profile string from the slim context object
  const buildPatientProfile = (ctx) => {
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
  };

  const patientProfile = buildPatientProfile(context);
  const isPersonalized = !!patientProfile;

  const prompt = isPersonalized
    ? `You are an expert clinical nutritionist and pharmacologist. A patient has been recommended "${supplementName}" based on their health assessment. Write a detailed, personalized supplement guide tailored specifically to this patient.

PATIENT PROFILE:
${patientProfile}

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
- Be specific — no generic filler. Every sentence should feel written for this patient.`

    : `You are an expert clinical nutritionist and pharmacologist. Write a detailed, accurate supplement information guide for: "${supplementName}"

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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are an expert clinical nutritionist. Always respond with valid JSON only — no markdown, no code fences, no extra text.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      console.error('Groq supplement detail error:', response.status, errText.substring(0, 200));
      return res.status(502).json({ message: 'AI service unavailable. Please try again.' });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(502).json({ message: 'Could not parse supplement details.' });
    }

    const detail = JSON.parse(jsonMatch[0]);
    return res.json(detail);

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error(`Supplement detail ${isTimeout ? 'timeout' : 'error'}:`, err.message);
    return res.status(502).json({ message: isTimeout ? 'Request timed out. Please try again.' : 'AI service error.' });
  }
});

module.exports = router;
