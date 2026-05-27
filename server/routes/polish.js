const express = require('express');
const router = express.Router();

// @route   POST /api/polish
// @desc    Polish a free-text health description using Groq AI
// @access  Public
router.post('/', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: 'No text provided.' });
    }

    const raw = text.trim();

    // Hard reject obvious garbage before hitting the API
    const isGarbage = (
      raw.length < 5 ||
      /^(.)\1{4,}$/.test(raw) ||                    // repeated chars: "aaaaaaa"
      /^[^a-zA-Z0-9\s]+$/.test(raw) ||              // only symbols
      /^(\w+\s?)\1{3,}$/.test(raw) ||               // repeated words: "test test test test"
      /^(asdf|qwerty|zxcv|1234|abcd)/i.test(raw)    // keyboard mashing
    );

    if (isGarbage) {
      return res.json({ polished: null, rejected: true, reason: 'garbage' });
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY || GROQ_API_KEY === 'your_groq_api_key_here') {
      // No API key — return cleaned version using basic preprocessing
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    const prompt = `You are a clinical documentation assistant. A patient has written a free-text description of their health concerns. Your job is to:

1. If the input is gibberish, random characters, spam, or completely unrelated to health — respond with exactly: REJECTED
2. If the input is valid health-related content (even if poorly written, in slang, or with errors):
   - Fix all spelling and grammar errors
   - Convert informal/slang language to professional medical language
   - Convert Filipino/Tagalog health terms to English equivalents
   - Rewrite as a clear, professional 2-4 sentence clinical description
   - Preserve ALL the original meaning and symptoms — do not add or invent anything
   - Write in third person ("The patient reports...")
   - Use possibility language ("reports", "describes", "indicates")
   - Do NOT include any explanation, preamble, or extra text — output ONLY the polished paragraph

Patient input: "${raw}"`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are a clinical documentation assistant. Follow instructions exactly. Output only the polished paragraph or the word REJECTED. No extra text.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error('[polish] Groq error:', response.status);
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim() || '';

    if (result === 'REJECTED' || result.toUpperCase().startsWith('REJECTED')) {
      return res.json({ polished: null, rejected: true, reason: 'not_health_related' });
    }

    if (!result || result.length < 10) {
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    return res.json({ polished: result, rejected: false });

  } catch (err) {
    console.error('[polish]', err.message);
    // Fallback — return basic cleaned version rather than failing
    const raw = req.body?.text?.trim() || '';
    return res.json({ polished: raw ? basicClean(raw) : null, rejected: false });
  }
});

// Basic cleanup when Groq is unavailable
function basicClean(text) {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^\w)/, c => c.toUpperCase());
}

module.exports = router;
