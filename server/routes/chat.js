const express = require('express');
const router = express.Router();

// ── System prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(recContext) {
  return `You are SuppliWise AI, a helpful assistant built into the SuppliWise web app. You are knowledgeable, warm, and have a light sense of humor.

You have deep knowledge about:
- SuppliWise app features (assessment, results, history, PDF export, account, navigation)
- Supplements, vitamins, minerals, nutrition, and health
- Symptoms and what they might indicate (dry skin, fatigue, joint pain, brain fog, etc.)
- Diet, lifestyle, sleep, exercise, and wellness
- General health questions of any kind

## PERSONALITY & OFF-TOPIC HANDLING
When a user asks something completely unrelated to health, wellness, or SuppliWise (like math problems, news, sports scores, coding, jokes, etc.), do NOT just answer it straight. Instead:
- Give a short, playful, friendly comeback that gently redirects them back to SuppliWise
- Keep it light and fun — never rude, sarcastic, or condescending
- Always end by offering to help with something SuppliWise-related
- Relate the comeback to health or supplements when possible

Examples of the tone to use:
- "1 + 1?" → "Ha, I'm better at counting supplements than numbers! 😄 But if you're curious about how many vitamins you should be taking, I can definitely help with that."
- "What's the news today?" → "I'm a bit out of the loop on world news — I spend all my time reading up on vitamins! 📰 Speaking of headlines, your health results are probably more interesting. Want to talk about your supplements?"
- "Tell me a joke" → "Why did the vitamin go to school? To get a little 'D'! 😄 Okay, okay — I'm better at supplement advice than comedy. What can I help you with today?"
- "Who won the game?" → "I don't follow sports, but I do know that magnesium is great for muscle recovery after a workout! 💪 Anything health-related I can help with?"
- "What's 50 * 8?" → "Math class is down the hall! 😄 I'm more of a 'how many mg of vitamin D should you take' kind of AI. Can I help you with something health-related?"

The key rule: always be warm and funny, never dismissive, and always bring it back to SuppliWise or health.

## HANDLING ACTION REQUESTS & NAVIGATION QUESTIONS
When a user asks to perform an action (like logging out, signing in, going somewhere), you CANNOT do it for them — you are a chat assistant, not a controller. Instead:
- Acknowledge what they want to do
- Give clear, specific instructions on how to do it themselves
- Be brief and direct — don't pad with unrelated suggestions

**Logout / Sign out:** The "Log Out" button is directly visible in the top-right navbar when you're logged in. Just click it.
**Login / Sign in:** Click "Sign In" in the top-right navbar. Enter email and password, then click Sign In.
**History page:** Click the clock icon in the top navigation bar on the right side.
**Home page:** Click the SuppliWise logo or "Home" in the navbar.
**Assessment:** Click "Start Assessment" on the home page, or "Assessment" in the navbar.
**Results:** After completing an assessment you'll be taken to Results automatically. You can also access past results from the History page.

IMPORTANT: Never respond to navigation or action requests with the generic help message. Always give specific instructions.

## SUPPLIWISE APP — COMPLETE FEATURE OVERVIEW

### Account & Authentication
- Register with name, email, and password (min 8 characters, at least one capital letter and one number)
- Login with email and password
- JWT-based sessions (7-day expiry)
- After registering, users land on the homepage first
- No profile editing, password reset, or settings page exists yet

### Health Assessment
- 4-step wizard: Basic Info → Diet & Goals → Symptoms → Medical Info
- Step 1: Age, gender, weight (kg), height (cm), activity level
- Step 2: Diet type (Omnivore, Vegan, Vegetarian, Keto, Paleo) and health goals (multi-select)
- Step 3: Symptoms with severity (Mild / Moderate / Severe), sleep quality, water intake
- Step 4: Medical conditions, medications, allergies, lifestyle habits, blood test results, free-text health description
- Progress is auto-saved to session — if you log in mid-assessment, your data is preserved
- Validation on all fields with friendly inline error messages

### Results Page
- Personalized supplement recommendations powered by Groq AI (Llama 3.3 70B)
- Each supplement card shows: name, priority (High/Medium/Low), confidence score (% match bar that animates on load), severity level, reason, dosage, timing, interactions
- The confidence bar animates from 0% to the actual score when the page loads — cards stagger one after another
- "Why recommended" field explains exactly what symptom or goal triggered each supplement
- Sections: Priority Supplements, Optional Supplements, Daily Schedule, Lifestyle Recommendations, Meal Recommendations, Action Plan, Warnings, Avoid List
- Export PDF button — downloads a fully formatted A4 PDF report of all recommendations
- Buttons at the bottom: Export PDF, View History, Retake Assessment, Back to Home

### History Page
- Shows all past assessments, newest first
- Each card displays: date, symptoms/goals summary, tags (age, diet, activity, symptom count, AI Analysis badge)
- Three action buttons on each card header:
  1. Eye icon — opens the full Results page for that assessment
  2. Download icon — exports a PDF report for that specific assessment
  3. Trash icon — deletes the assessment (with confirmation modal)
- Expand a card to see tabs: Assessment data, Supplements, Daily Schedule, Lifestyle, Meals, Action Plan, Warnings
- Toast notification confirms deletion

### PDF Export
- Available from both the Results page (Export PDF button) and the History page (download icon on each card)
- Generates a formatted A4 PDF with: branded header, clinical summary, patient profile, supplement table, daily schedule, lifestyle advice, meal recommendations, action plan, warnings
- Downloads automatically as SuppliWise_Report_YYYY-MM-DD.pdf

### Chat Assistant (you)
- Floating "Ask AI" bubble in the bottom-right corner
- Available on all pages except Login and Sign Up
- Remembers conversation context within the session
- Can answer questions about the app, supplements, health, wellness, and your specific recommendations

## FEATURES THAT DO NOT EXIST YET — NEVER TELL USERS HOW TO USE THESE
If a user asks about any of these, honestly say it isn't available yet and suggest what they CAN do instead:
- Profile editing / changing name, email, or password — no profile or settings page
- Password reset / forgot password — not implemented
- Notifications or reminders — not implemented
- Supplement tracking or logging daily intake — not implemented
- Social features, sharing, or community — not implemented
- Dark mode — not implemented
- Mobile app — web only, no mobile app
- Comparing assessments side by side — not implemented
- Subscription, premium, or paid features — not implemented
- QR/barcode scanning — not implemented
${recContext ? `\n## USER'S CURRENT RECOMMENDATIONS\n${recContext}` : ''}

Answer every question fully and helpfully. Never say you can't answer something.`;
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

    // ── Try Groq first ─────────────────────────────────────────────────────
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (GROQ_API_KEY && GROQ_API_KEY !== 'your_groq_api_key_here') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        console.log('[chat] Calling Groq for:', q.substring(0, 60));
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
            temperature: 0.65,
            stream: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          const reply = data.choices?.[0]?.message?.content?.trim();
          if (reply && reply.length > 10) {
            console.log('[chat] Groq replied OK');
            return res.json({ reply, source: 'groq' });
          }
        } else {
          const errText = await response.text();
          console.error('[chat] Groq HTTP error:', response.status, errText.substring(0, 300));
        }
      } catch (e) {
        clearTimeout(timeout);
        console.error('[chat] Groq fetch failed:', e.name, e.message);
      }
    } else {
      console.warn('[chat] No GROQ_API_KEY — using fallback');
    }

    // ── Smart local fallback ───────────────────────────────────────────────
    console.log('[chat] Using smartFallback for:', q.substring(0, 60));
    return res.json({ reply: smartFallback(q, context || []), source: 'fallback' });

  } catch (err) {
    console.error('[chat route]', err.message);
    return res.json({
      reply: "I'm having trouble right now. Please try again in a moment.",
      source: 'error',
    });
  }
});

// ── Smart fallback ─────────────────────────────────────────────────────────
function smartFallback(question, context) {
  const q = question.toLowerCase().trim();

  // ── Greetings ──
  if (/^(hi|hey|hello|sup|yo|hiya|howdy|good morning|good afternoon|good evening|what'?s up|wassup)[\s!?.]*$/.test(q)) {
    return `Hey! 👋 I'm SuppliWise AI — your personal health and supplement assistant.\n\nI can help you with:\n- Questions about your supplement recommendations\n- Supplements, vitamins, and nutrition\n- Symptoms and what might help\n- How to use any feature on SuppliWise\n\nWhat's on your mind?`;
  }

  // ── What can you do ──
  if (/what can you do|what do you do|what are you|who are you|your capabilities|help me with/.test(q)) {
    return `I'm SuppliWise AI — here's what I can help with:\n\n**Health & Supplements**\n- "I'm always tired, what helps?"\n- "What is vitamin D?"\n- "What supplements help with sleep?"\n- "I have joint pain, what should I take?"\n\n**Your Assessment & Results**\n- Questions about your specific recommendations\n- What each supplement does and why it was recommended\n- Dosage, timing, and interactions\n\n**Using SuppliWise**\n- How to start an assessment\n- How to export a PDF report\n- How to find your history\n- Account and navigation help\n\nJust ask me anything!`;
  }

  // ── How are you / small talk ──
  if (/how are you|how('?re| are) you doing|you okay|you good|what('?s| is) up with you/.test(q)) {
    return `I'm doing great, thanks for asking! 😄 Always ready to talk supplements and health.\n\nHow are *you* feeling? If something's been bothering you — fatigue, sleep issues, joint pain — I can suggest what might help.`;
  }

  // ── Thanks ──
  if (/^(thanks|thank you|thx|ty|cheers|appreciate it|thank u)[\s!.]*$/.test(q)) {
    return `You're welcome! 😊 Let me know if you have any other questions about your health or supplements.`;
  }

  // ── Jokes ──
  if (/joke|funny|make me laugh|tell me something funny/.test(q)) {
    const jokes = [
      `Why did the vitamin go to school? To get a little "D"! 😄\n\nOkay, I'll stick to supplement advice. What can I help you with?`,
      `Why did the magnesium break up with calcium? Because it needed its space! 🧲\n\nAlright, comedy isn't my strong suit — but supplement advice is. What do you need?`,
      `What do you call a sleeping supplement? A rest-oration! 😴\n\nI'll leave the jokes to the professionals. Anything health-related I can help with?`,
      `Why did the omega-3 go to therapy? It had too many emotional fatty acids! 🐟\n\nOkay okay, I'm better at health advice than jokes. What's on your mind?`,
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // ── Nonsense / too short ──
  if (/^[^a-zA-Z]*$/.test(q) || q.length < 3) {
    return `Hmm, I'm not sure what to make of that! 😄 I'm best at health, supplements, and SuppliWise questions.\n\nTry asking me something like:\n- "I'm always tired, what helps?"\n- "What is vitamin D?"\n- "How do I start an assessment?"`;
  }

  // ── Skin ──
  if (/dry skin|skin.*dry|flaky skin|skin.*itch|itchy skin/.test(q)) {
    return `**Dry skin** can be caused by several things — here's what may help:\n\n**Supplements:**\n- 🐟 **Omega-3 (Fish Oil)** — strengthens the skin barrier. 1,000–2,000mg daily\n- 💧 **Vitamin E** — antioxidant that protects skin cells. 200–400 IU daily\n- ☀️ **Vitamin D** — deficiency is linked to dry, rough skin. 1,000–2,000 IU daily\n- 💪 **Collagen** — supports skin elasticity and moisture. 5–10g daily\n- 🌿 **Evening Primrose Oil** — rich in GLA, helps with skin moisture\n\n**Lifestyle tips:**\n- Drink at least 2L of water daily\n- Moisturize within 3 minutes of showering\n- Avoid hot showers (they strip natural oils)\n\nIf dryness is severe or persistent, it could indicate a thyroid issue or eczema — worth checking with a doctor.`;
  }

  // ── Fatigue / tiredness ──
  if (/fatigue|tired|exhausted|no energy|low energy|always sleepy|feel weak/.test(q)) {
    return `**Fatigue** is one of the most common health complaints. Here's what commonly helps:\n\n**Top supplements for energy:**\n- 💉 **Vitamin B12** — deficiency causes extreme fatigue. 500–1,000mcg daily\n- ☀️ **Vitamin D** — low levels are strongly linked to fatigue. 1,000–4,000 IU daily\n- 🧲 **Magnesium** — essential for energy production. 200–400mg glycinate form at night\n- 🔴 **Iron** — if you're anemic, this is critical. Get a blood test first\n- ❤️ **CoQ10** — supports cellular energy. 100–200mg with meals\n- 🌿 **Ashwagandha** — adaptogen that reduces fatigue and stress. 300–600mg daily\n\n**Lifestyle:** Aim for 7–9 hours of sleep, stay hydrated, eat regular meals.\n\nIf fatigue is severe and persistent, get a blood panel (B12, iron, vitamin D, thyroid).`;
  }

  // ── Sleep ──
  if (/can't sleep|insomnia|poor sleep|sleep better|trouble sleeping|wake up.*night/.test(q)) {
    return `**Sleep issues** are very common. Here's what can help:\n\n**Supplements:**\n- 🌙 **Magnesium Glycinate** — relaxes muscles and calms the nervous system. 200–400mg before bed\n- 🌙 **Melatonin** — helps regulate your sleep cycle. Start with 0.5–1mg\n- 🌿 **Ashwagandha** — reduces cortisol that keeps you awake. 300mg before bed\n- 🍵 **L-Theanine** — promotes relaxation without drowsiness. 100–200mg\n- 🌿 **Valerian Root** — traditional sleep herb. 300–600mg before bed\n\n**Sleep hygiene:**\n- Keep a consistent sleep/wake time\n- Avoid screens 1 hour before bed\n- Keep your room cool (18–20°C)\n- Avoid caffeine after 2pm`;
  }

  // ── Joint pain ──
  if (/joint pain|joint.*ache|knee pain|back pain|arthritis|stiff joint|inflam/.test(q)) {
    return `**Joint pain and inflammation** can be helped with the right supplements:\n\n- 🟡 **Curcumin (Turmeric)** — powerful anti-inflammatory. 500–1,000mg with black pepper\n- 🐟 **Omega-3 Fish Oil** — reduces joint inflammation. 2,000–3,000mg EPA+DHA daily\n- 🦴 **Glucosamine + Chondroitin** — supports cartilage health\n- 🌿 **Boswellia** — reduces joint swelling and pain. 300–500mg daily\n- 🧲 **Magnesium** — muscle and joint relaxation. 300–400mg daily\n\nFor severe or sudden joint pain, see a doctor to rule out gout, rheumatoid arthritis, or injury.`;
  }

  // ── Brain fog / focus ──
  if (/brain fog|can't focus|focus|concentration|memory|mental clarity|forgetful/.test(q)) {
    return `**Brain fog and poor focus** are often linked to nutrient deficiencies:\n\n- 💉 **Vitamin B12** — critical for brain function. 500–1,000mcg daily\n- 🐟 **Omega-3 (DHA)** — the main structural fat in the brain. 1,000–2,000mg daily\n- 🍄 **Lion's Mane Mushroom** — promotes nerve growth factor. 500–1,000mg daily\n- 🧲 **Magnesium L-Threonate** — crosses the blood-brain barrier, improves memory\n- 🌿 **Ashwagandha** — reduces stress hormones that impair cognition\n\nSleep is the #1 factor for cognitive function — prioritize 7–9 hours.`;
  }

  // ── Anxiety / stress ──
  if (/anxiety|stress|anxious|panic|overwhelm|nervous|worry/.test(q)) {
    return `**Anxiety and stress** can be significantly helped:\n\n- 🌿 **Ashwagandha** — the most evidence-backed adaptogen for stress. 300–600mg daily\n- 🧲 **Magnesium Glycinate** — calms the nervous system. 300–400mg daily\n- 🍵 **L-Theanine** — promotes calm focus without sedation. 100–200mg\n- 💉 **Vitamin B Complex** — B vitamins are depleted by stress\n- 🌿 **Rhodiola Rosea** — reduces burnout and mental fatigue\n\nFor severe anxiety, please speak with a mental health professional.`;
  }

  // ── Hair loss ──
  if (/hair loss|hair.*fall|thinning hair|bald|hair.*grow/.test(q)) {
    return `**Hair loss** can have several causes:\n\n- 🔴 **Iron** — iron deficiency is a leading cause, especially in women. Get tested first\n- 💉 **Biotin (B7)** — supports keratin production. 2,500–5,000mcg daily\n- 🛡️ **Zinc** — deficiency causes hair shedding. 15–30mg daily\n- ☀️ **Vitamin D** — low levels linked to alopecia\n- 💪 **Collagen** — provides amino acids for hair structure\n\nHair supplements take 3–6 months to show results — be patient.`;
  }

  // ── Weight / metabolism ──
  if (/weight loss|lose weight|metabolism|overweight|fat burn|belly fat/.test(q)) {
    return `**Weight management** is about sustainable habits:\n\n- 🌱 **Berberine** — improves insulin sensitivity. 500mg 2–3x daily with meals\n- 🌿 **Green Tea Extract** — modest fat-burning effect\n- 🐟 **Omega-3** — reduces inflammation and may improve fat metabolism\n- 💉 **Vitamin D** — deficiency is linked to weight gain\n\n**What actually works:** caloric deficit, high protein diet, strength training, 7–9 hours sleep.\n\n⚠️ Avoid fat-burning supplements with stimulants — most are ineffective and some are dangerous.`;
  }

  // ── Immunity ──
  if (/immune|immunity|sick often|frequent cold|get sick|boost immune/.test(q)) {
    return `**Boosting immunity** comes down to a few key nutrients:\n\n- 🍊 **Vitamin C** — 500–1,000mg daily\n- ☀️ **Vitamin D** — arguably the most important immune vitamin. 2,000–4,000 IU daily\n- 🛡️ **Zinc** — essential for immune cell production. 15–30mg daily\n- 🦠 **Probiotics** — 70% of the immune system is in the gut\n- 🌿 **Elderberry** — reduces duration and severity of colds\n\nSleep is the most powerful immune booster — 7–9 hours.`;
  }

  // ── Digestion / gut ──
  if (/digest|gut|bloat|constipat|diarrhea|ibs|stomach|bowel/.test(q)) {
    return `**Digestive issues** often respond well to supplements:\n\n- 🦠 **Probiotics** — restore healthy gut bacteria. Multi-strain, 10–50 billion CFU\n- 🌿 **Digestive Enzymes** — help break down food, reduce bloating. Take with meals\n- 🧲 **Magnesium** — relieves constipation. 200–400mg\n- 🌱 **Psyllium Husk** — soluble fiber that regulates bowel movements\n- 🌿 **Ginger** — reduces nausea and bloating\n\nFor persistent or severe digestive issues, see a gastroenterologist.`;
  }

  // ── What is [supplement] ──
  if (/what is|what does|tell me about|explain/.test(q)) {
    if (/vitamin d/.test(q)) return `**Vitamin D** is a fat-soluble vitamin your body makes from sunlight. Essential for:\n- Calcium absorption and bone health\n- Immune system function\n- Mood regulation (low D is linked to depression)\n\n**Deficiency signs:** fatigue, bone pain, muscle weakness, frequent illness\n**Dosage:** 1,000–4,000 IU daily with a fat-containing meal\n\nUp to 40% of people are deficient.`;
    if (/vitamin c/.test(q)) return `**Vitamin C** is a water-soluble antioxidant essential for immune function, collagen production, and iron absorption.\n\n**Dosage:** 500–1,000mg daily\n**Sources:** Citrus fruits, bell peppers, strawberries, broccoli\n**Safe limit:** Up to 2,000mg/day`;
    if (/magnesium/.test(q)) return `**Magnesium** is involved in over 300 body processes:\n- Muscle and nerve function\n- Sleep quality\n- Stress and anxiety regulation\n- Energy production\n\n**Best forms:** Glycinate (sleep/anxiety), Citrate (constipation), Malate (energy)\n**Dosage:** 200–400mg daily`;
    if (/omega.?3|fish oil/.test(q)) return `**Omega-3 fatty acids** (EPA and DHA) are essential fats your body can't make:\n- Reduce inflammation\n- Support heart health\n- Brain function and mood\n- Joint health\n\n**Dosage:** 1,000–3,000mg combined EPA+DHA daily with meals`;
    if (/zinc/.test(q)) return `**Zinc** is essential for immune function, wound healing, and testosterone production.\n\n**Dosage:** 15–30mg daily with food\n**Deficiency signs:** Frequent illness, hair loss, poor wound healing, loss of taste/smell`;
  }

  // ── Logout ──
  if (/log.?out|sign.?out|log me out|logout|signout/.test(q)) {
    return `To log out, click the **"Log Out"** button in the **top-right corner** of the navbar — it's always visible when you're signed in.`;
  }

  // ── Navigation ──
  if (/where.*history|find.*history|go.*history|history.*page/.test(q)) {
    return `The **History page** is in the top navigation bar — click the **clock icon** on the right side of the navbar.`;
  }

  if (/where.*home|go.*home|back.*home/.test(q)) {
    return `Click the **SuppliWise logo** in the top-left of the navbar.`;
  }

  if (/where.*assessment|find.*assessment|start.*assessment/.test(q)) {
    return `Click **"Start Assessment"** on the home page, or **"Assessment"** in the top navigation bar.`;
  }

  if (/where.*result|find.*result|see.*result/.test(q)) {
    return `Your results appear automatically after completing an assessment. To revisit past results, go to **History** and click the **eye icon** on any card.`;
  }

  // ── App questions ──
  if (/how.*start|get started|how.*use|how.*work/.test(q)) {
    return `Here's how to use SuppliWise:\n\n1. **Start Assessment** — Click the button on the home page\n2. **Complete 4 steps** — Basic info, diet & goals, symptoms, medical info\n3. **Get Results** — Personalized supplement recommendations\n4. **View History** — All past assessments saved in your account`;
  }

  if (/confidence|match.*score|%.*mean/.test(q)) {
    return `The **confidence score** is the animated % bar on each supplement card.\n\n- **90–100%** — Direct match to your exact symptoms\n- **80–89%** — Good match based on symptoms + severity\n- **70–79%** — Moderate match\n- **Below 70%** — Partial match with fewer data points`;
  }

  if (/sign.?up|register|create.*account/.test(q)) {
    return `To create an account:\n1. Click **Sign In** in the navbar\n2. Click "Create one" at the bottom\n3. Enter your name, email, and a strong password (8+ chars, one capital, one number)`;
  }

  if (/export|pdf|download.*report/.test(q)) {
    return `You can download a **PDF report** in two ways:\n1. **Results page** — click **Export PDF** at the bottom\n2. **History page** — click the **download icon** on any past assessment card`;
  }

  if (/log.?in|sign.?in/.test(q)) {
    return `To log in:\n1. Click **Sign In** in the top-right navbar\n2. Enter your email and password\n3. Click "Sign In"`;
  }

  // ── Off-topic — playful redirect ──
  const offTopicResponses = [
    `Ha, I'm not sure that's in my supplement handbook! 😄 I'm best at health, nutrition, and SuppliWise questions. What's going on with your health lately?`,
    `That's a bit outside my expertise — I'm more of a vitamins-and-wellness kind of AI! 💊 Is there anything health-related I can help you with?`,
    `Interesting question, but my knowledge is mostly limited to supplements and health! 😄 Ask me about fatigue, sleep, immunity, or how to use SuppliWise.`,
    `I'd love to help with that, but I'm really only an expert in one thing: keeping you healthy! 🌿 Got any health questions?`,
  ];

  // ── Has recommendations context ──
  if (context && context.length > 0) {
    return `Based on your assessment, you have **${context.length} supplement recommendations**. I can answer questions about any of them — dosage, timing, why it was recommended, or interactions. What would you like to know?`;
  }

  // ── Last resort — conversational, not robotic ──
  return offTopicResponses[Math.floor(Math.random() * offTopicResponses.length)];
}

module.exports = router;
