const express = require('express');
const router = express.Router();

// ── System prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(recContext) {
  return `You are SuppliWise AI, a helpful assistant built into the SuppliWise web app. You are knowledgeable, warm, conversational, and have a light sense of humor — like a friendly expert, not a robot.

You can talk about ANYTHING the user brings up. You are not restricted to health topics only. You engage naturally in conversation, answer questions, and always bring things back to health or SuppliWise when it makes sense.

## PERSONALITY
- Warm, friendly, and conversational — like texting a knowledgeable friend
- Light humor when appropriate — never stiff or robotic
- Short responses for small talk, detailed responses for real questions
- Never say "I can only help with health topics" — you can chat about anything

## OFF-TOPIC HANDLING
When a user asks something unrelated to health or SuppliWise (math, news, sports, celebrities, coding, etc.):
- Give a short, playful, friendly response
- Gently tie it back to health or SuppliWise if possible
- Keep it fun — never dismissive

Examples:
- "hey yow" → "Hey! What's up? 😄 Anything health-related on your mind, or just stopping by?"
- "do you know mia khalifa?" → "Ha, I know a lot of things but I'm mostly an expert in vitamins and wellness! 😄 Anything health-related I can help with?"
- "1 + 1?" → "2! But I'm way better at counting supplement doses than math problems 😄 Need help with anything health-related?"
- "tell me a joke" → "Why did the vitamin go to school? To get a little D! 😄 Okay I'll stick to health advice. What's on your mind?"

## NAVIGATION & ACCOUNT QUESTIONS
When users ask how to do something in the app, give clear step-by-step instructions:
- **Log out:** Click the "Log Out" button in the top-right navbar
- **Log in / Sign in:** Click "Sign In" in the top-right navbar
- **History:** Click the clock icon in the top-right navbar
- **Start assessment:** Click "Start Assessment" on the home page
- **Results:** Automatically shown after assessment, or click eye icon in History

## FEATURES THAT DON'T EXIST YET
Be honest and helpful — never pretend these exist:
- Profile editing, changing username/email/password/profile picture — NOT available. Suggest retaking the assessment to update health info.
- Password reset / forgot password — NOT implemented
- Notifications, reminders — NOT implemented
- Supplement tracking / daily logging — NOT implemented
- Dark mode — NOT implemented
- Mobile app — web only
- Comparing assessments — NOT implemented
- Subscription / premium features — NOT implemented

## SUPPLIWISE APP FEATURES
- 4-step health assessment: Basic Info → Diet & Goals → Symptoms → Medical Info
- AI-powered supplement recommendations (Groq Llama 3.3 70B)
- Each recommendation has: name, priority (High/Medium/Low), confidence score, dosage, timing, interactions
- Daily schedule, lifestyle advice, meal recommendations, action plan, warnings
- PDF export from Results page or History page
- History page: view, download PDF, or delete past assessments
- Chat assistant (you): available on all pages except Login and Sign Up
${recContext ? `\n## USER'S CURRENT RECOMMENDATIONS\n${recContext}` : ''}

Be conversational. Be helpful. Answer everything.`;
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

    // ── Try Groq ───────────────────────────────────────────────────────────
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

    // ── Fallback (only if Groq is completely down) ─────────────────────────
    return res.json({ reply: smartFallback(q, context || []), source: 'fallback' });

  } catch (err) {
    console.error('[chat route]', err.message);
    return res.json({
      reply: "I'm having trouble right now. Please try again in a moment.",
      source: 'error',
    });
  }
});

// ── Smart fallback — only runs when Groq is unavailable ───────────────────
// Handles the most common questions so the app still works without an API key
function smartFallback(question, context) {
  const q = question.toLowerCase().trim();

  // Greetings
  if (/^(hi|hey|hello|sup|yo|hiya|howdy|good morning|good afternoon|good evening|what'?s up|wassup|hey yow|yo yo)[\s!?.]*$/.test(q)) {
    return `Hey! 👋 I'm SuppliWise AI — your health and supplement assistant. What's on your mind?`;
  }

  // What can you do
  if (/what can you do|what do you do|what are you|who are you|capabilities/.test(q)) {
    return `I'm SuppliWise AI! Here's what I can help with:\n\n**Health & Supplements**\n- "I'm always tired, what helps?"\n- "What is vitamin D?"\n- "What supplements help with sleep?"\n\n**Your Results**\n- Questions about your specific recommendations\n- Dosage, timing, and interactions\n\n**Using SuppliWise**\n- How to start an assessment\n- How to find your history\n- How to export a PDF\n\nJust ask me anything!`;
  }

  // How are you
  if (/how are you|how('?re| are) you doing|you okay|you good/.test(q)) {
    return `Doing great, thanks for asking! 😄 How are *you* feeling? Any health questions I can help with?`;
  }

  // Thanks
  if (/^(thanks|thank you|thx|ty|cheers|appreciate it|thank u)[\s!.]*$/.test(q)) {
    return `You're welcome! 😊 Let me know if you have any other questions.`;
  }

  // Jokes
  if (/joke|funny|make me laugh/.test(q)) {
    const jokes = [
      `Why did the vitamin go to school? To get a little "D"! 😄\n\nOkay, I'll stick to supplement advice. What can I help you with?`,
      `Why did the magnesium break up with calcium? Because it needed its space! 🧲\n\nAlright, comedy isn't my strong suit — but supplement advice is. What do you need?`,
      `Why did the omega-3 go to therapy? It had too many emotional fatty acids! 🐟\n\nI'm better at health advice than jokes. What's on your mind?`,
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // Profile / account editing
  if (/profile|profile pic|pfp|avatar|change.*name|change.*email|change.*password|change.*username|edit.*account|account.*settings|settings/.test(q)) {
    return `Profile editing isn't available yet in SuppliWise — there's no settings or profile page currently.\n\nWhat you **can** do:\n- Retake the assessment anytime to update your health profile\n- View past assessments in **History**\n- Export a PDF of your recommendations\n\nProfile editing is planned for a future update.`;
  }

  // Logout
  if (/log.?out|sign.?out|log me out/.test(q)) {
    return `To log out, click the **"Log Out"** button in the **top-right corner** of the navbar.`;
  }

  // History navigation
  if (/where.*history|find.*history|go.*history|how.*history/.test(q)) {
    return `Click the **clock icon** in the top-right navbar to go to your History page.`;
  }

  // Where to start / how to use
  if (/where.*start|how.*start|get started|how.*use|how.*work|where do i begin/.test(q)) {
    return `Here's how to use SuppliWise:\n\n1. **Start Assessment** — Click the button on the home page\n2. **Complete 4 steps** — Basic info, diet & goals, symptoms, medical info\n3. **Get Results** — Personalized supplement recommendations\n4. **View History** — All past assessments saved in your account`;
  }

  // Health topics
  if (/tired|fatigue|exhausted|no energy/.test(q)) {
    return `**Fatigue** is very common. Top supplements that may help:\n- 💉 **Vitamin B12** — 500–1,000mcg daily\n- ☀️ **Vitamin D** — 1,000–4,000 IU daily\n- 🧲 **Magnesium Glycinate** — 200–400mg at night\n- 🌿 **Ashwagandha** — 300–600mg daily\n\nFor a full personalized plan, take the health assessment!`;
  }

  if (/sleep|insomnia|can't sleep/.test(q)) {
    return `For better sleep:\n- 🌙 **Magnesium Glycinate** — 200–400mg before bed\n- 🌙 **Melatonin** — start with 0.5–1mg\n- 🍵 **L-Theanine** — 100–200mg\n- 🌿 **Ashwagandha** — reduces cortisol that keeps you awake\n\nFor a full personalized plan, take the health assessment!`;
  }

  if (/anxiety|stress|anxious/.test(q)) {
    return `For anxiety and stress:\n- 🌿 **Ashwagandha** — 300–600mg daily\n- 🧲 **Magnesium Glycinate** — 300–400mg daily\n- 🍵 **L-Theanine** — 100–200mg\n\nFor severe anxiety, please speak with a mental health professional.`;
  }

  // Generic health fallback with context
  if (context && context.length > 0) {
    return `Based on your assessment, you have **${context.length} supplement recommendations**. I can answer questions about any of them — dosage, timing, why it was recommended, or interactions. What would you like to know?`;
  }

  // Last resort — conversational, not robotic
  const responses = [
    `Hey, I'm not sure I caught that — could you rephrase? I'm best at health, supplements, and SuppliWise questions. 😊`,
    `Hmm, I'm not quite sure what you mean! Try asking me about your health, supplements, or how to use SuppliWise.`,
    `I didn't quite get that one! 😄 Ask me about fatigue, sleep, immunity, or how to use any feature on SuppliWise.`,
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

module.exports = router;
