const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { completeWithFallback } = require('../utils/aiRouter');

// @route   POST /api/polish
// @desc    Polish a free-text health description using the routed AI provider
// @access  Private — authenticated callers only. This endpoint spends real
//          provider quota on every request; leaving it anonymous made it a
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

    // Provider, model, key AND fallback all come from the routing table, so this
    // route cannot disagree with the admin panel about which model is in use — the
    // bug this replaces: this file sent `deepseek/deepseek-v4-flash` while the
    // panel reported `...-0731` for the very same key.
    //
    // It used to resolve a single target and hand-roll its own `fetch`. That made
    // this the one call site that ignored the declared fallback, so a provider
    // that could not answer dropped straight to `basicClean` instead of trying
    // the next one — and it hard-coded an OpenRouter-only request field, which is
    // a 400 on every other provider. Walking the chain fixes both at once.
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

    // Patient text travels as its own message so it cannot override the
    // instructions above, and `json: false` because the model is asked for prose
    // (or the literal word REJECTED), not an object.
    const result = await completeWithFallback('polish', {
      system: prompt,
      user: raw,
      maxTokens: 300,
      temperature: 0.2,
      timeoutMs: 12000,
      json: false,
      // `reasoning.effort` is an OpenRouter-GATEWAY field. Scoped by provider key
      // so it is never sent to a provider that would reject it as unknown.
      extraBody: (target) => (target.provider === 'openrouter'
        ? { reasoning: { effort: 'none' } }
        : null),
    });

    // Every provider in the chain failed. Name which ones and why — a silent drop
    // to `basicClean` is how a revoked key goes unnoticed for months.
    if (!result.ok) {
      console.error('[polish] no provider answered:', JSON.stringify(result.attempts || []));
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    const output = String(result.text || '').trim();

    if (output === 'REJECTED' || output.toUpperCase().startsWith('REJECTED')) {
      return res.json({ polished: null, rejected: true, reason: 'not_health_related' });
    }

    if (!output || output.length < 10) {
      return res.json({ polished: basicClean(raw), rejected: false });
    }

    return res.json({ polished: output, rejected: false });

  } catch (err) {
    console.error('[polish]', err.message);
    // Fallback — return basic cleaned version rather than failing. Re-read the
    // body defensively: it may be exactly what caused the error above.
    const raw = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    return res.json({ polished: raw ? basicClean(raw) : null, rejected: false });
  }
});

// Basic cleanup when the AI provider is unavailable
function basicClean(text) {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^\w)/, c => c.toUpperCase());
}

module.exports = router;
