const express = require('express');
const router = express.Router();

// ── System prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(recContext) {
  return `You are SuppliWise AI, a focused health and wellness assistant built into the SuppliWise web app.

## YOUR ROLE
You ONLY answer questions about:
1. Health, wellness, nutrition, supplements, vitamins, minerals, symptoms, diet, sleep, exercise, hydration, and lifestyle
2. The SuppliWise app — features, navigation, assessments, results, history, PDF export, account

## STRICT OFF-TOPIC RULE — CRITICAL
If the user asks about ANYTHING outside those two categories — celebrities, sports, math, movies, politics, coding, weather, general knowledge, jokes, entertainment, news, or any other non-health/non-SuppliWise topic — you MUST respond with ONLY a short, polite decline. Do NOT answer the question. Do NOT engage with the topic at all. Do NOT bridge it to health.

Use one of these styles (vary them naturally):
- "I'm only able to help with health, wellness, and SuppliWise questions. Is there something health-related I can assist you with?"
- "That's outside what I can help with — I'm focused on health and SuppliWise. Got any supplement or wellness questions?"
- "I'm not the right assistant for that! I specialize in health, nutrition, and SuppliWise. Anything wellness-related I can help with?"
- "I can only assist with health and SuppliWise topics. Feel free to ask me about supplements, nutrition, or how to use the app!"

## YOUR PERSONALITY (within health/SuppliWise topics only)
- Friendly, warm, and knowledgeable — like a helpful nutritionist
- Clear and concise for simple questions, detailed for complex health topics
- Use possibility language ("may help", "evidence suggests") — never diagnose
- Never robotic or dismissive on health topics
- **TYPO HANDLING**: If the user's message contains an obvious misspelling of a health/supplement/app term, gently acknowledge it and proceed with the corrected meaning. Format: "It looks like you might mean [corrected term] — [answer]." Only do this for clear health-related typos (e.g. "vitamen d" → "Vitamin D", "magnisium" → "magnesium", "suppliment" → "supplement", "ashwaganda" → "ashwagandha"). Do NOT correct grammar or non-health words.

## SUPPLIWISE APP — FULL FEATURE GUIDE

### Navigation
- Log out: Click "Log Out" button in the top-right navbar
- Log in: Click "Sign In" in the top-right navbar
- History: Click the clock icon in the top-right navbar
- Start assessment: Click "Start Assessment" on the home page
- Results: Shown automatically after assessment, or click eye icon in History

### Health Assessment (4 steps)
- Step 1: Age, gender, weight, height, activity level
- Step 2: Diet type, health goals
- Step 3: Symptoms with severity, sleep quality, water intake
- Step 4: Medical conditions, medications, allergies, lifestyle habits, blood test results, free-text description
- Progress auto-saves — if you log in mid-assessment your data is preserved

### Results Page
- Personalized supplement recommendations powered by Groq AI (Llama 4 Maverick)
- Each card: name, priority (High/Medium/Low), confidence score (animated % bar), dosage, timing, interactions, why it was recommended
- Sections: Priority Supplements, Optional Supplements, Daily Schedule, Lifestyle Advice, Meal Recommendations, Action Plan, Warnings, Avoid List
- Export PDF button at the bottom

### History Page
- All past assessments, newest first
- Eye icon: view full results
- Download icon: export PDF for that assessment
- Trash icon: delete with confirmation
- Expand card to see tabs: Assessment, Supplements, Schedule, Lifestyle, Meals, Action Plan, Warnings

### Confidence Score
- Animated % bar on each supplement card
- 90-100%: direct match to your exact symptoms
- 80-89%: good match based on symptoms + severity
- 70-79%: moderate match
- Below 70%: partial match

### Priority Levels
- High (red): most important, start in Week 1
- Medium (yellow): beneficial for your goals, add in Week 2
- Low (green): preventive/general wellness, optional

### PDF Export
- Available from Results page (Export PDF button) or History page (download icon per card)
- Includes: clinical summary, supplement table, daily schedule, lifestyle advice, meal recommendations, action plan, warnings

### Account & Auth
- Register: name, email, password (min 8 chars, one capital, one number)
- JWT sessions, 7-day expiry
- Passwords hashed with bcrypt

## FEATURES THAT DON'T EXIST YET
Be honest — never pretend these exist:
- Profile editing, changing username/email/password/profile picture: NOT available
- Password reset / forgot password: NOT implemented
- Notifications or reminders: NOT implemented
- Supplement tracking / daily logging: NOT implemented
- Dark mode: NOT implemented
- Mobile app: web only
- Comparing assessments side by side: NOT implemented

## HEALTH & SUPPLEMENT KNOWLEDGE
Deep knowledge about supplements, vitamins, minerals, nutrition, symptoms, diet, lifestyle, sleep, exercise, and wellness. Answer health questions fully. Use possibility language ("may help", "evidence suggests") — never diagnose.
${recContext ? `\n## USER'S CURRENT RECOMMENDATIONS\n${recContext}` : ''}`;
}

// ── POST /api/chat ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { message, context, history } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ reply: 'Please enter a message.' });
    }

    const q = message.trim();
    const t = q.toLowerCase();

    // ── Off-topic pre-filter ───────────────────────────────────────────────
    // Catch clearly non-health/non-SuppliWise messages before hitting the AI
    const offTopicPatterns = [
      // People / celebrities
      /who is (messi|ronaldo|taylor swift|elon musk|trump|biden|obama|beyonce|drake|kanye|lebron|kobe|eminem|rihanna|adele|harry styles|ariana|billie eilish)/i,
      // Math
      /^what is \d+\s*[\+\-\*\/]\s*\d+/i,
      /^(solve|calculate|compute)\s+\d/i,
      // Entertainment
      /(best movie|best song|best album|best show|netflix|spotify|youtube|tiktok|instagram|twitter|facebook|reddit)/i,
      // Sports scores / teams
      /(who won|final score|match result|game score|nba|nfl|fifa|premier league|la liga)/i,
      // Weather
      /^(what('s| is) the weather|will it rain|temperature (today|tomorrow)|forecast)/i,
      // Coding / tech unrelated to health
      /(write (me )?(a |some )?(code|function|script|program|html|css|javascript|python)|how to (code|program|hack|install))/i,
      // Politics / news
      /(president|prime minister|election|vote|congress|senate|parliament|war|military|nuclear|missile)/i,
      // Jokes / entertainment requests
      /^(tell me a joke|say something funny|make me laugh|do a trick|sing|rap|write (me )?(a |some )?(poem|song|story|essay|rap))/i,
      // Food recipes (not nutrition)
      /^(how (do i|to) (cook|bake|make|prepare|fry|boil|grill)|recipe for|ingredients for)/i,
    ];

    const isOffTopic = offTopicPatterns.some(p => p.test(t));
    if (isOffTopic) {
      const declines = [
        "I'm only able to help with health, wellness, and SuppliWise questions. Is there something health-related I can assist you with?",
        "That's outside what I can help with — I'm focused on health and SuppliWise. Got any supplement or wellness questions?",
        "I'm not the right assistant for that! I specialize in health, nutrition, and SuppliWise. Anything wellness-related I can help with?",
        "I can only assist with health and SuppliWise topics. Feel free to ask me about supplements, nutrition, or how to use the app!",
      ];
      return res.json({ reply: declines[Math.floor(Math.random() * declines.length)], source: 'filter' });
    }

    const recContext = context && context.length > 0
      ? context.slice(0, 5).map(r =>
          `- ${r.name} (${r.priority} priority, ${r.confidenceScore || '?'}% confidence): ${r.reason?.substring(0, 120) || ''}`
        ).join('\n')
      : null;

    const messages = [
      { role: 'system', content: buildSystemPrompt(recContext) },
    ];

    if (history && Array.isArray(history)) {
      for (const msg of history.slice(-8)) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.text || msg.content || '' });
        }
      }
    }

    messages.push({ role: 'user', content: q });

    // ── Groq ───────────────────────────────────────────────────────────────
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (GROQ_API_KEY && GROQ_API_KEY !== 'your_groq_api_key_here') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages,
            max_tokens: 700,
            temperature: 0.7,
            stream: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply && reply.length > 0) {
            return res.json({ reply, source: 'groq' });
          }
        } else {
          const errText = await response.text();
          console.error('[chat] Groq error:', response.status, errText.substring(0, 200));
        }
      } catch (e) {
        clearTimeout(timeout);
        console.error('[chat] Groq failed:', e.name, e.message);
      }
    }

    // ── Fallback — only if Groq is completely unreachable ─────────────────
    return res.json({ reply: offlineFallback(q), source: 'fallback' });

  } catch (err) {
    console.error('[chat route]', err.message);
    return res.json({
      reply: "I'm having trouble right now. Please try again in a moment.",
      source: 'error',
    });
  }
});

// ── Offline fallback — only runs when Groq is completely down ─────────────
// Minimal, honest, never pretends to be smart
function offlineFallback(q) {
  const t = q.toLowerCase();

  if (/^(hi|hey|hello|sup|yo|wassup|hiya)/.test(t)) {
    return `Hey! 👋 I'm having a bit of trouble connecting right now, but I'll be back shortly. Try again in a moment!`;
  }

  if (/log.?out|sign.?out/.test(t)) {
    return `To log out, click the **"Log Out"** button in the top-right navbar.`;
  }

  if (/history/.test(t)) {
    return `Click the **clock icon** in the top-right navbar to view your History.`;
  }

  if (/tired|fatigue|sleep|anxiety|stress|vitamin|supplement|iron|magnesium|zinc/.test(t)) {
    return `I'm having trouble connecting to my AI right now. Please try again in a moment — I'll have a full answer for you shortly!`;
  }

  return `I'm having a bit of trouble right now. Please try again in a moment! 🙏`;
}

module.exports = router;
