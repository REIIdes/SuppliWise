const express = require('express');
const router = express.Router();

// ── System prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(recContext) {
  return `You are SuppliWise AI, a helpful assistant built into the SuppliWise web app. You are knowledgeable, warm, and have a light sense of humor.

You have deep knowledge about:
- SuppliWise app features (assessment, results, history, account, navigation)
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

SuppliWise app overview:
- 4-step health assessment: Basic Info → Diet & Goals → Symptoms → Medical Info
- Results page: personalized supplement recommendations with confidence scores, priority levels (High/Medium/Low), severity levels, dosages, timing, daily schedule, meal recommendations, lifestyle advice, action plan
- History page: view and delete past assessments with full AI results
- Account: sign up, log in, log out (JWT auth)
- Chat assistant (you): floating bubble bottom-right, available on all pages except Login and Signup

## FEATURES THAT DO NOT EXIST YET — NEVER TELL USERS HOW TO USE THESE
The following features have NOT been built. If a user asks about them, honestly say the feature isn't available yet and suggest what they CAN do instead:
- Profile editing / changing name, email, or password — there is NO profile page or settings page
- Password reset / forgot password — not implemented
- Notifications or reminders — not implemented
- Supplement tracking or logging daily intake — not implemented
- Social features, sharing, or community — not implemented
- Dark mode — not implemented
- Mobile app — there is no mobile app, only the web app
- Exporting or downloading results as PDF — not implemented
- Comparing assessments side by side — not implemented
- Subscription, premium, or paid features — not implemented
${recContext ? `\nUser's current recommendations:\n${recContext}` : ''}

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

    // ── Try Groq first (fast, free — needs GROQ_API_KEY in .env) ─────────
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
            return res.json({ reply, source: 'groq' });
          }
        } else {
          console.warn('Groq error:', response.status, await response.text());
        }
      } catch (e) {
        clearTimeout(timeout);
        console.warn('Groq failed:', e.message);
      }
    }

    // ── Smart local fallback — answers anything without an API ────────────
    return res.json({ reply: smartFallback(q, context || []), source: 'fallback' });

  } catch (err) {
    console.error('[chat route]', err.message);
    return res.json({
      reply: "I'm having trouble right now. Please try again in a moment.",
      source: 'error',
    });
  }
});

// ── Smart fallback — handles any question with built-in knowledge ──────────
function smartFallback(question, context) {
  const q = question.toLowerCase();

  // ── Skin ──
  if (/dry skin|skin.*dry|flaky skin|skin.*flak|skin.*itch|itchy skin/.test(q)) {
    return `**Dry skin** can be caused by several things — here's what may help:\n\n**Supplements that support skin hydration:**\n- 🐟 **Omega-3 (Fish Oil)** — strengthens the skin barrier and reduces inflammation. 1,000–2,000mg EPA+DHA daily with meals\n- 💧 **Vitamin E** — antioxidant that protects skin cells. 200–400 IU daily\n- ☀️ **Vitamin D** — deficiency is linked to dry, rough skin. 1,000–2,000 IU daily\n- 💪 **Collagen** — supports skin elasticity and moisture. 5–10g daily\n- 🌿 **Evening Primrose Oil** — rich in GLA, helps with skin moisture\n\n**Lifestyle tips:**\n- Drink at least 2L of water daily\n- Use a humidifier in dry environments\n- Moisturize within 3 minutes of showering\n- Avoid hot showers (they strip natural oils)\n- Eat foods rich in healthy fats: avocado, nuts, salmon, olive oil\n\nIf dryness is severe or persistent, it could indicate a thyroid issue or eczema — worth checking with a doctor.`;
  }

  // ── Fatigue / tiredness ──
  if (/fatigue|tired|exhausted|no energy|low energy|always sleepy|feel weak/.test(q)) {
    return `**Fatigue** is one of the most common health complaints. Here's what commonly helps:\n\n**Top supplements for energy:**\n- 💉 **Vitamin B12** — deficiency causes extreme fatigue, especially in vegans/vegetarians. 500–1,000mcg daily\n- ☀️ **Vitamin D** — low levels are strongly linked to fatigue. 1,000–4,000 IU daily\n- 🧲 **Magnesium** — essential for energy production. 200–400mg glycinate form at night\n- 🔴 **Iron** — if you're anemic, this is critical. Get a blood test first before supplementing\n- ❤️ **CoQ10** — supports cellular energy, especially if you take statins. 100–200mg with meals\n- 🌿 **Ashwagandha** — adaptogen that reduces fatigue and stress. 300–600mg daily\n\n**Lifestyle factors:**\n- Aim for 7–9 hours of sleep\n- Stay hydrated (dehydration causes fatigue)\n- Eat regular balanced meals — skipping meals crashes energy\n- Light exercise actually boosts energy levels\n\nIf fatigue is severe and persistent, get a blood panel (B12, iron, vitamin D, thyroid) — it's often a simple deficiency.`;
  }

  // ── Sleep ──
  if (/can't sleep|insomnia|poor sleep|sleep better|trouble sleeping|wake up.*night/.test(q)) {
    return `**Sleep issues** are very common. Here's what can help:\n\n**Supplements for better sleep:**\n- 🌙 **Magnesium Glycinate** — relaxes muscles and calms the nervous system. 200–400mg 30–60 min before bed\n- 🌙 **Melatonin** — helps regulate your sleep cycle. Start with 0.5–1mg (low dose works better than high)\n- 🌿 **Ashwagandha** — reduces cortisol and stress that keeps you awake. 300mg before bed\n- 🍵 **L-Theanine** — promotes relaxation without drowsiness. 100–200mg\n- 🌿 **Valerian Root** — traditional sleep herb. 300–600mg before bed\n\n**Sleep hygiene tips:**\n- Keep a consistent sleep/wake time (even weekends)\n- Avoid screens 1 hour before bed (blue light suppresses melatonin)\n- Keep your room cool (65–68°F / 18–20°C is ideal)\n- Avoid caffeine after 2pm\n- Avoid alcohol — it disrupts deep sleep\n\nIf you've had sleep issues for months, consider talking to a doctor about sleep apnea.`;
  }

  // ── Joint pain ──
  if (/joint pain|joint.*ache|knee pain|back pain|arthritis|stiff joint|inflam/.test(q)) {
    return `**Joint pain and inflammation** can be helped with the right supplements:\n\n- 🟡 **Curcumin (Turmeric)** — powerful anti-inflammatory. 500–1,000mg with black pepper (piperine) for absorption\n- 🐟 **Omega-3 Fish Oil** — reduces joint inflammation. 2,000–3,000mg EPA+DHA daily\n- 🦴 **Glucosamine + Chondroitin** — supports cartilage health. 1,500mg glucosamine + 1,200mg chondroitin daily\n- 🌿 **Boswellia** — reduces joint swelling and pain. 300–500mg daily\n- 🧲 **Magnesium** — muscle and joint relaxation. 300–400mg daily\n- ☀️ **Vitamin D** — deficiency worsens joint pain. 2,000 IU daily\n\n**Lifestyle:**\n- Low-impact exercise (swimming, cycling) keeps joints mobile\n- Maintain a healthy weight — every extra kg adds 4x pressure on knees\n- Anti-inflammatory diet: berries, leafy greens, fatty fish, olive oil\n- Avoid processed foods and sugar (pro-inflammatory)\n\nFor severe or sudden joint pain, see a doctor to rule out gout, rheumatoid arthritis, or injury.`;
  }

  // ── Brain fog / focus ──
  if (/brain fog|can't focus|focus|concentration|memory|mental clarity|forgetful/.test(q)) {
    return `**Brain fog and poor focus** are often linked to nutrient deficiencies or lifestyle factors:\n\n**Supplements for mental clarity:**\n- 💉 **Vitamin B12** — critical for brain function and nerve health. 500–1,000mcg daily\n- 🐟 **Omega-3 (DHA)** — DHA is the main structural fat in the brain. 1,000–2,000mg daily\n- 🍄 **Lion's Mane Mushroom** — promotes nerve growth factor (NGF). 500–1,000mg daily\n- 🧲 **Magnesium L-Threonate** — crosses the blood-brain barrier, improves memory. 1,500–2,000mg daily\n- 🌿 **Ashwagandha** — reduces stress hormones that impair cognition. 300–600mg daily\n- 🍵 **L-Theanine + Caffeine** — improves focus without jitters\n\n**Lifestyle:**\n- Sleep is the #1 factor for cognitive function — prioritize 7–9 hours\n- Exercise increases blood flow to the brain\n- Stay hydrated — even mild dehydration impairs focus\n- Reduce sugar and processed carbs (cause energy crashes)\n\nPersistent brain fog can also be caused by thyroid issues, anemia, or sleep apnea.`;
  }

  // ── Anxiety / stress ──
  if (/anxiety|stress|anxious|panic|overwhelm|nervous|worry/.test(q)) {
    return `**Anxiety and stress** can be significantly helped with the right supplements and habits:\n\n**Supplements:**\n- 🌿 **Ashwagandha** — the most evidence-backed adaptogen for stress and anxiety. 300–600mg daily\n- 🧲 **Magnesium Glycinate** — calms the nervous system. 300–400mg daily\n- 🍵 **L-Theanine** — promotes calm focus without sedation. 100–200mg\n- 💉 **Vitamin B Complex** — B vitamins are depleted by stress. Take a B-complex daily\n- 🌿 **Rhodiola Rosea** — reduces burnout and mental fatigue. 200–400mg daily\n- ☀️ **Vitamin D** — low levels are linked to anxiety and depression\n\n**Lifestyle:**\n- Deep breathing (4-7-8 technique) activates the parasympathetic nervous system\n- Regular exercise is as effective as medication for mild anxiety\n- Limit caffeine — it directly increases cortisol and anxiety\n- Journaling and mindfulness reduce rumination\n- Prioritize sleep — anxiety and sleep deprivation feed each other\n\nFor severe anxiety, please speak with a mental health professional.`;
  }

  // ── Hair loss ──
  if (/hair loss|hair.*fall|thinning hair|bald|hair.*grow/.test(q)) {
    return `**Hair loss** can have several causes — here's what commonly helps:\n\n**Supplements for hair health:**\n- 🔴 **Iron** — iron deficiency is a leading cause of hair loss, especially in women. Get tested first\n- 💉 **Biotin (B7)** — supports keratin production. 2,500–5,000mcg daily\n- 🛡️ **Zinc** — deficiency causes hair shedding. 15–30mg daily with food\n- ☀️ **Vitamin D** — low levels linked to alopecia. 2,000 IU daily\n- 💪 **Collagen** — provides amino acids for hair structure. 5–10g daily\n- 🐟 **Omega-3** — nourishes hair follicles and reduces scalp inflammation\n\n**Common causes to investigate:**\n- Thyroid dysfunction (get TSH tested)\n- Iron deficiency anemia\n- Hormonal changes (postpartum, menopause, PCOS)\n- High stress (telogen effluvium — stress-related shedding)\n- Protein deficiency\n\nHair supplements take 3–6 months to show results — be patient.`;
  }

  // ── Weight / metabolism ──
  if (/weight loss|lose weight|metabolism|overweight|fat burn|belly fat/.test(q)) {
    return `**Weight management** is about sustainable habits, not quick fixes. Here's what actually helps:\n\n**Supplements with evidence:**\n- 🌱 **Berberine** — improves insulin sensitivity and metabolism. 500mg 2–3x daily with meals\n- 🌿 **Green Tea Extract (EGCG)** — modest fat-burning effect. 400–500mg daily\n- 🐟 **Omega-3** — reduces inflammation and may improve fat metabolism\n- 🧲 **Magnesium** — improves insulin sensitivity. 300–400mg daily\n- 💉 **Vitamin D** — deficiency is linked to weight gain and metabolic issues\n\n**What actually works:**\n- Caloric deficit (eat ~300–500 fewer calories than you burn)\n- High protein diet (keeps you full, preserves muscle)\n- Strength training (builds muscle, raises resting metabolism)\n- Sleep 7–9 hours (poor sleep increases hunger hormones)\n- Reduce ultra-processed foods and liquid calories\n\n⚠️ Avoid fat-burning supplements with stimulants — most are ineffective and some are dangerous.`;
  }

  // ── Immunity ──
  if (/immune|immunity|sick often|frequent cold|get sick|boost immune/.test(q)) {
    return `**Boosting immunity** comes down to a few key nutrients and habits:\n\n**Top immune supplements:**\n- 🍊 **Vitamin C** — antioxidant that supports immune cell function. 500–1,000mg daily\n- ☀️ **Vitamin D** — arguably the most important immune vitamin. 2,000–4,000 IU daily\n- 🛡️ **Zinc** — essential for immune cell production. 15–30mg daily (short-term)\n- 🦠 **Probiotics** — 70% of the immune system is in the gut. Multi-strain, 10+ billion CFU\n- 🌿 **Elderberry** — reduces duration and severity of colds. 500–1,000mg during illness\n- 🧄 **Garlic Extract** — antimicrobial and immune-boosting properties\n\n**Lifestyle:**\n- Sleep is the most powerful immune booster — 7–9 hours\n- Chronic stress suppresses immunity — manage it actively\n- Exercise moderately (intense overtraining suppresses immunity)\n- Eat a colorful diet rich in vegetables and fruits\n- Stay hydrated\n\nIf you're getting sick very frequently, get your vitamin D and zinc levels checked.`;
  }

  // ── Digestion / gut ──
  if (/digest|gut|bloat|constipat|diarrhea|ibs|stomach|bowel/.test(q)) {
    return `**Digestive issues** are very common and often respond well to supplements:\n\n**Key supplements:**\n- 🦠 **Probiotics** — restore healthy gut bacteria. Multi-strain with Lactobacillus and Bifidobacterium, 10–50 billion CFU\n- 🌿 **Digestive Enzymes** — help break down food, reduce bloating. Take with meals\n- 🧲 **Magnesium** — relieves constipation (magnesium citrate or oxide). 200–400mg\n- 🌱 **Psyllium Husk** — soluble fiber that regulates bowel movements. 5–10g with water\n- 🌿 **Ginger** — reduces nausea and bloating. 500–1,000mg or fresh ginger tea\n- 🌿 **Peppermint Oil (enteric-coated)** — proven for IBS symptoms\n\n**Diet tips:**\n- Eat slowly and chew thoroughly\n- Identify trigger foods (common: gluten, dairy, FODMAPs, spicy food)\n- Eat fermented foods: yogurt, kefir, sauerkraut, kimchi\n- Stay hydrated — dehydration causes constipation\n- Reduce processed food and artificial sweeteners\n\nFor persistent or severe digestive issues, see a gastroenterologist.`;
  }

  // ── What is [supplement] ──
  if (/what is|what does|tell me about|explain/.test(q)) {
    if (/vitamin d/.test(q)) return `**Vitamin D** is a fat-soluble vitamin your body makes from sunlight. It's essential for:\n- Calcium absorption and bone health\n- Immune system function\n- Mood regulation (low D is linked to depression)\n- Muscle function\n\n**Deficiency signs:** fatigue, bone pain, muscle weakness, frequent illness, low mood\n**Dosage:** 1,000–4,000 IU daily with a fat-containing meal\n**Sources:** Sunlight, fatty fish, egg yolks, fortified milk\n\nVitamin D deficiency is extremely common — up to 40% of people are deficient.`;
    if (/vitamin c/.test(q)) return `**Vitamin C** is a water-soluble antioxidant essential for:\n- Immune function\n- Collagen production (skin, joints, wound healing)\n- Iron absorption\n- Protecting cells from oxidative damage\n\n**Dosage:** 500–1,000mg daily\n**Sources:** Citrus fruits, bell peppers, strawberries, broccoli\n**Safe limit:** Up to 2,000mg/day (higher doses cause digestive upset)`;
    if (/magnesium/.test(q)) return `**Magnesium** is involved in over 300 body processes:\n- Muscle and nerve function\n- Sleep quality\n- Stress and anxiety regulation\n- Energy production\n- Blood sugar control\n\n**Best forms:** Glycinate (sleep/anxiety), Citrate (constipation), Malate (energy)\n**Dosage:** 200–400mg daily\n**Deficiency signs:** Muscle cramps, poor sleep, anxiety, fatigue, headaches`;
    if (/omega.?3|fish oil/.test(q)) return `**Omega-3 fatty acids** (EPA and DHA) are essential fats your body can't make:\n- Reduce inflammation throughout the body\n- Support heart health (lower triglycerides)\n- Brain function and mood\n- Joint health\n- Skin hydration\n\n**Dosage:** 1,000–3,000mg combined EPA+DHA daily with meals\n**Sources:** Fatty fish (salmon, sardines), fish oil capsules, algae oil (vegan)\n**Note:** May interact with blood thinners at high doses`;
    if (/zinc/.test(q)) return `**Zinc** is a mineral essential for:\n- Immune function\n- Wound healing\n- DNA synthesis\n- Taste and smell\n- Testosterone production\n\n**Dosage:** 15–30mg daily with food (to avoid nausea)\n**Deficiency signs:** Frequent illness, hair loss, poor wound healing, loss of taste/smell\n**Note:** Don't take long-term at high doses — it depletes copper`;
  }

  // ── SuppliWise app questions ──
  if (/how.*start|get started|what.*do|how.*use|how.*work/.test(q)) {
    return `Here's how to use SuppliWise:\n\n1. **Start Assessment** — Click the button on the home page\n2. **Complete 4 steps** — Basic info, diet & goals, symptoms, medical info\n3. **Get Results** — Personalized supplement recommendations with dosages, timing, and a daily schedule\n4. **View History** — All past assessments saved in your account\n\nYou need to be logged in to submit — if you're not, you'll be redirected to login and your progress is saved automatically.`;
  }

  if (/confidence|match.*score|percent|%.*mean/.test(q)) {
    return `The **confidence score** (% bar on each supplement card) shows how strongly your health data supports that recommendation:\n\n- **90–100%** — Direct match to your exact symptoms\n- **80–89%** — Good match based on symptoms + severity\n- **70–79%** — Moderate match for your general profile\n- **Below 70%** — Partial match with fewer data points`;
  }

  if (/priority|high.*priority|medium.*priority|low.*priority/.test(q)) {
    return `**Priority levels:**\n\n- 🔴 **High** — Most important for your specific symptoms. Start here in Week 1.\n- 🟡 **Medium** — Beneficial for your goals. Add in Week 2.\n- 🟢 **Low** — Preventive/general wellness. Optional additions.\n\nIntroduce one supplement at a time over 3–5 days.`;
  }

  if (/history|past.*assessment|previous.*result/.test(q)) {
    return `The **History page** shows all your past assessments. Each card expands to show tabs for:\n- 📋 Assessment data\n- 💊 Supplement recommendations\n- 🕐 Daily schedule\n- 🌿 Lifestyle advice\n- 🍽️ Meal recommendations\n- 📅 Action plan\n\nYou can delete any assessment with the 🗑 button (permanent).`;
  }

  if (/sign.?up|register|create.*account/.test(q)) {
    return `To create an account:\n1. Click **Sign In** in the navbar\n2. Click "Create one" at the bottom of the login page\n3. Enter your name, email, and password (min 6 characters)\n4. You're logged in immediately after registering.`;
  }

  if (/log.?in|sign.?in/.test(q)) {
    return `To log in:\n1. Click **Sign In** in the top-right navbar\n2. Enter your email and password\n3. Click "Sign In"\n\nUse the 👁 icon to show/hide your password.`;
  }

  // ── Generic health question fallback ──
  if (context && context.length > 0) {
    return `Based on your assessment, you have **${context.length} supplement recommendations**. I can answer questions about any of them — dosage, timing, why it was recommended, side effects, or interactions. What would you like to know?`;
  }

  // ── Absolute last resort — still give a helpful response ──
  return `I'm here to help with anything — your health, supplements, or how SuppliWise works.\n\nSome things I can answer:\n- "My skin is dry, what should I do?"\n- "What is vitamin D?"\n- "How do I start an assessment?"\n- "What does the confidence score mean?"\n- "I'm always tired, what supplements help?"\n\nWhat's on your mind?`;
}

module.exports = router;
