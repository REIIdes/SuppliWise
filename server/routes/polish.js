const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');

// @route   POST /api/polish
// @desc    Polish a free-text health description using OpenRouter AI (DeepSeek V4 Flash)
// @access  Private — authenticated callers only. This endpoint spends real
//          OpenRouter quota on every request; leaving it anonymous made it a
//          free AI proxy for anyone who found the route (the ip-based
//          aiLimiter alone only slows an attacker down). Verified there is no
//          unauthenticated caller anywhere in the frontend before adding it.
router.post('/', protect, async (req, res) => {
  try {
    // Type-guard first: a non-string body field (number, object, array) must
    // never reach .trim() — the catch below re-reads req.body too, so a throw
    // there would escape this async handler as an unhandled rejection.
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ message: 'No text provided.' });
    }

    const raw = text.trim();

    // Bound input size — this is a public AI endpoint, so cap tokens before the API call
    if (raw.length > 1000) {
      return res.status(400).json({ message: 'Please keep descriptions under 1000 characters.' });
    }

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

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'your_openrouter_api_key_here') {
      // No API key — return cleaned version using basic preprocessing
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    const prompt = `Polish the following patient-written health description:

1. If the input is gibberish, random characters, spam, or completely unrelated to health — respond with exactly: REJECTED
2. If the input is valid health-related content (even if poorly written, in slang, or with errors):
   - Fix all spelling and grammar errors
   - Convert informal/slang language to professional medical language
   - Convert Filipino/Tagalog health terms to English equivalents
   - Rewrite as a clear, professional 2-4 sentence clinical description
   - Preserve ALL the original meaning and symptoms — do not add or invent anything
   - Write in third person ("The patient reports...")
   - Use possibility language ("reports", "describes", "indicates")
   - Do NOT include any explanation, preamble, or extra text — output ONLY the polished paragraph`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content: prompt,
          },
          // Patient text travels as its own message so it cannot override the instructions above
          { role: 'user', content: raw },
        ],
        max_tokens: 300,
        temperature: 0.2,
        stream: false,
        reasoning: { effort: 'none' },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error('[polish] OpenRouter error:', response.status);
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    const data = await response.json();
    const choice = data.choices?.[0]?.message;
    const result = String(choice?.content || choice?.reasoning || '').trim();

    if (result === 'REJECTED' || result.toUpperCase().startsWith('REJECTED')) {
      return res.json({ polished: null, rejected: true, reason: 'not_health_related' });
    }

    if (!result || result.length < 10) {
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    return res.json({ polished: result, rejected: false });

  } catch (err) {
    console.error('[polish]', err.message);
    // Fallback — return basic cleaned version rather than failing. Re-read the
    // body defensively: it may be exactly what caused the error above.
    const raw = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    return res.json({ polished: raw ? basicClean(raw) : null, rejected: false });
  }
});

// Basic cleanup when OpenRouter is unavailable
function basicClean(text) {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^\w)/, c => c.toUpperCase());
}

module.exports = router;
