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

## SUPPLIWISE APP — COMPLETE FEATURE GUIDE

### Core Pages
- **HomePage** (root): Landing with redirects to assessment or dashboard
- **AssessmentPage** (route /assessment): 4-step health questionnaire
- **ResultsPage** (route /results): AI supplement recommendations with confidence scores & priorities
- **DashboardPage** (route /dashboard): Track Intake tab + Recommendations tab
- **TrackIntakePage** (route /track): Daily supplement tracker with calendar
- **RecommendationsPage** (route /recommendations): Browse AI recommendations with filters/sorting
- **HistoryPage** (route /history): Past assessments (view/export PDF, NO delete option)
- **InsightsPage** (route /insights): 4 tabs - Overview, Today's Progress, Adherence, AI Insight
- **ProfilePage** (route /profile): Edit info, pictures, password. **Logout button at bottom of page (left side on desktop, below Edit Profile on mobile). Access profile by clicking avatar/name in top-right navbar.**

### Navigation
**Navbar:** Logo (→dashboard) | Clock icon (top-right, →history) | Avatar/name (top-right, →profile) | Sign In (when logged out)

### Authentication & Account
**Registration:** Name, email, DOB, gender, password (min 8 chars, 1 uppercase, 1 number)
**Login:** Email + password, JWT tokens (7-day expiry)
**✅ FORGOT PASSWORD EXISTS:** Click "Forgot Password?" → Enter email → Receive 6-digit OTP → Verify (10-min expiry) → Set new password
**Profile Editing:** Name, email, DOB, gender, profile picture (max 2MB), banner (max 3MB), password (needs current)
**Email Change:** Triggers OTP verification
**Logout:** Profile page bottom left (desktop: Logout left, Edit Profile right | mobile: Edit Profile top, Logout below)

### Assessment (4 Steps)
1. Basic: Age, gender, weight, height, activity level
2. Diet & Goals: Diet type, health goals (energy, sleep, immunity, digestion, mental clarity, stress, heart, bone, muscle, skin, weight, hormonal, joint, etc.)
3. Symptoms: Select with severity (mild/moderate/severe), sleep quality, water intake
4. Medical: Conditions, medications, allergies, lifestyle (smoking/alcohol/caffeine), blood tests (optional), notes
- AI: Groq (Llama 4 Maverick), auto-saves progress

### Results & Supplements
**Supplement Cards:** Name, dosage, timing, priority (High/Med/Low), confidence % (90-100%=direct match, 80-89%=good, 70-79%=moderate, <70%=partial), reason, interactions
**Sections:** Priority Supplements, Optional, Daily Schedule, Lifestyle Advice, Meals, Action Plan, Warnings, Avoid List
**PDF Export:** Available from results page & history page

### Dashboard
**Track Intake Tab:** Mark supplements as taken by time slot (Morning/Afternoon/Evening/Night), completion counter, toast when all taken
**Recommendations Tab:** Browse all, filter (All/Priority/Optional), sort (Priority/Name/Confidence), "+ Add to Plan" button

### Tracking & Insights
**Track Intake Page:** Today's supplements list (priority dots), mark taken/undo, calendar with completion colors (green=100%, yellow=partial, red=missed, blue=today), adherence %, streak counter
**Insights Page:**
- Overview: Stats (streak, adherence, wellness score, assessments), current phase, lifestyle tips
- Today's Progress: Circular chart, supplement list with status
- Adherence: Weekly bar chart (7 days), action plan phases
- AI Insight: Enhanced phase guidance, personalized tips

### History
- All assessments (newest first), eye icon (view), download icon (PDF)
- **NO DELETE OPTION** - assessments are permanent
- Expandable cards with tabs

### Recommendations
- Full list, filter/sort, "+ Add to Plan", "Added to Plan" badge

### ✅ FEATURES THAT EXIST
- Forgot password (OTP-based reset)
- Profile editing (all fields + pictures)
- Password change (needs current)
- Email change with OTP
- Supplement tracking (daily checkboxes by time)
- Calendar view (monthly with completion)
- Adherence tracking (weekly & overall %)
- Streak tracking (current & longest)
- Insights page (4 tabs)
- PDF export (results & history)
- Add to Plan (add/remove from tracker)
- Filters & sorting (recommendations)
- Completion toast (when all supplements taken)
- OTP verification (password reset & email change)

### ❌ FEATURES THAT DON'T EXIST
- Delete assessments (history is permanent)
- Email/push notifications or reminders
- Dark mode (light only)
- Native mobile app (web-based, APK for Android sideload)
- Compare assessments side-by-side
- Social features or sharing
- Wearable integration (no Apple Watch/Fitbit)
- Detailed supplement logging (only daily checkboxes, no notes/time)
- Supplement time-based reminders
- Custom supplement addition (only AI-recommended)
- Progress charts beyond adherence (no detailed wellness/symptom graphs)

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
    console.error('[chat route] Stack:', err.stack);
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
    return `To log out, go to your **Profile Settings** (click your avatar/name in the top-right navbar), then click the red **"Log Out"** button at the bottom.`;
  }

  if (/history/.test(t)) {
    return `Click the **clock icon** in the top-right navbar to view your History page with all past assessments.`;
  }

  if (/tired|fatigue|sleep|anxiety|stress|vitamin|supplement|iron|magnesium|zinc/.test(t)) {
    return `I'm having trouble connecting to my AI right now. Please try again in a moment — I'll have a full answer for you shortly!`;
  }

  return `I'm having a bit of trouble right now. Please try again in a moment! 🙏`;
}

module.exports = router;
