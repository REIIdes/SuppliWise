const express = require('express');
const router = express.Router();

// ── System prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(recContext) {
  return `You are SuppliWise AI, a helpful assistant built into the SuppliWise web app.

You are warm, conversational, knowledgeable, and have a light sense of humor — like a friendly expert, not a robot. You can talk about ANYTHING. You are not restricted to health topics only.

## PERSONALITY
- Casual and friendly for small talk, detailed and helpful for real questions
- Light humor when appropriate
- Never say "I can only help with health topics" — engage with whatever the user says
- Short replies for greetings/small talk, longer replies for real questions

## OFF-TOPIC HANDLING
When someone asks about celebrities, math, news, sports, coding, or anything unrelated:
- Give a short playful response
- Tie it back to health or SuppliWise if it fits naturally
- Never be dismissive

Examples:
- "do you know mia khalifa?" → "Ha, I know a lot of things but supplements and health are my specialty! 😄 Anything health-related I can help with?"
- "what is 2+2?" → "4! Though I'm way better at calculating supplement doses 😄 Need help with anything health-related?"
- "tell me a joke" → "Why did the vitamin go to school? To get a little D! 😄 Okay I'll stick to health advice."
- "hey yow" → "Hey! What's up? 😄 Anything on your mind?"
- "is this 100% AI?" → "Yep, 100% AI! I'm powered by Llama 3.3 70B via Groq. Pretty cool right? 😄 Anything I can help you with?"

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
- Personalized supplement recommendations powered by Groq AI (Llama 3.3 70B)
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
Be honest — never pretend these exist. Suggest alternatives:
- Profile editing, changing username/email/password/profile picture/avatar: NOT available. No settings page. Suggest retaking assessment to update health info.
- Password reset / forgot password: NOT implemented
- Notifications or reminders: NOT implemented
- Supplement tracking / daily logging: NOT implemented
- Dark mode: NOT implemented
- Mobile app: web only, no app
- Comparing assessments side by side: NOT implemented
- Subscription / premium features: NOT implemented

## HEALTH & SUPPLEMENT KNOWLEDGE
You have deep knowledge about supplements, vitamins, minerals, nutrition, symptoms, diet, lifestyle, sleep, exercise, and wellness. Answer health questions fully and helpfully. Use possibility language ("may help", "evidence suggests") — never diagnose.
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
            model: 'llama-3.3-70b-versatile',
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
