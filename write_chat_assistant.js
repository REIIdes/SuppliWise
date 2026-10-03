const fs = require('fs');
const path = require('path');

const dest = path.join(__dirname, 'my-react-app/src/Pages/ChatAssistant.jsx');

const code = String.raw`import { useState, useRef, useEffect } from 'react';
import './ChatAssistant.css';

// ── Supplement icon map ────────────────────────────────────────────────────
const ICONS = {
  magnesium:'🧲','vitamin d':'☀️','vitamin b':'💉',b12:'💉',
  omega:'🐟','fish oil':'🐟',iron:'🔴',zinc:'🛡️',
  'vitamin c':'🍊',calcium:'🦴',coq10:'❤️',probiotic:'🦠',
  ashwagandha:'🌿',"lion's mane":'🍄',curcumin:'🟡',berberine:'🌱',
  selenium:'⚡',collagen:'💪',creatine:'💪',melatonin:'🌙',
  'vitamin k':'🥦',riboflavin:'🟠',theanine:'🍵',glucosamine:'🦴',
  nac:'🛡️',prenatal:'🤰',dha:'🐟',epa:'🐟',
};
function getIcon(name){
  const n=(name||'').toLowerCase();
  for(const[k,v]of Object.entries(ICONS)) if(n.includes(k)) return v;
  return '💊';
}

// ── Medical disclaimer ─────────────────────────────────────────────────────
const DISCLAIMER = '\n\n⚕️ *This is for educational purposes only and does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement.*';

// ── Off-topic detector ─────────────────────────────────────────────────────
const WELLNESS_TOPICS = /supplement|vitamin|mineral|nutrient|health|wellness|diet|nutrition|sleep|stress|fatigue|energy|immune|gut|digest|brain|focus|anxiety|mood|joint|muscle|bone|heart|blood|weight|exercise|workout|fitness|protein|omega|magnesium|iron|zinc|calcium|b12|coq10|probiotic|ashwagandha|melatonin|dosage|dose|timing|side effect|interact|allerg|medication|drug|condition|symptom|recommend|evidence|study|research|food|meal|eat|hydrat|water|smoke|alcohol|pregnancy|breastfeed|vegan|vegetarian|keto|paleo|omnivore|high|mild|moderate|severe|priority|confidence|score|plan|schedule|action|lifestyle|habit|bmi|weight|height|age|gender|history|assessment|result|analysis|safe|danger|toxic|overdose|store|expire|brand|cost|budget|how long|when.*work|result|feel better|effect|week|month|what.*mean|explain|definition|what is|what does|tell me about|why|how|can i|should i|is it|are there/i;

function isOffTopic(q) {
  return !WELLNESS_TOPICS.test(q);
}

// ── Priority / severity explainers ────────────────────────────────────────
const PRIORITY_EXPLANATION = `**What do the priority levels mean?**

🔴 **High Priority** — Strongly supported by your health profile. These address your most significant reported symptoms or conditions. Start with these in Week 1.

🟡 **Medium Priority** — Beneficial based on your goals or secondary symptoms. Add these in Week 2 once you've tolerated the high-priority ones.

🟢 **Low Priority** — Preventive or general wellness support. Optional additions once your core plan is established.

💡 *Never start all supplements at once — introduce one at a time over 3–5 days to identify any reactions.*`;

const SEVERITY_EXPLANATION = `**What do the severity levels mean?**

🔴 **Severe** — Your reported symptoms are significantly impacting daily life. Recommendations are prioritized and dosed accordingly. Consider consulting a doctor.

🟠 **Moderate** — Noticeable symptoms affecting quality of life. Standard therapeutic doses are recommended.

🟡 **Mild to Moderate** — Symptoms present but manageable. Moderate doses with lifestyle changes are the focus.

🟢 **Mild** — Early or occasional symptoms. Lower doses and preventive strategies are appropriate.

⚪ **Preventive** — No active symptoms. Supplements support long-term health maintenance.`;

const CONFIDENCE_EXPLANATION = `**What does the confidence score mean?**

The confidence score (e.g. 92%) reflects how strongly your health data supports a specific recommendation:

• **90–100%** — Direct match: a supplement has strong clinical evidence for your exact reported symptom or condition (e.g. magnesium for poor sleep)
• **80–89%** — Good match: supported by your symptom + severity combination
• **70–79%** — Moderate match: general wellness support based on your profile
• **Below 70%** — Partial data: fewer details were provided, so recommendations are less personalized

📚 *Scores are based on NIH, PubMed, and Mayo Clinic evidence levels, not AI guessing.*`;

// ── Knowledge base ─────────────────────────────────────────────────────────
const KB = [
  {
    patterns: /what.*mean|explain|definition|high.*priority|medium.*priority|low.*priority|priority.*level/,
    response: PRIORITY_EXPLANATION,
  },
  {
    patterns: /severe|mild to moderate|mild.*mean|moderate.*mean|severity.*level|what.*severity/,
    response: SEVERITY_EXPLANATION,
  },
  {
    patterns: /confidence.*score|what.*confidence|score.*mean|percent.*match|match.*percent/,
    response: CONFIDENCE_EXPLANATION,
  },
  {
    patterns: /overdose|too much|exceed|over.dose|double dose|miss.*dose|forgot.*dose/,
    response: `⚠️ **Taking too much of a supplement**

It depends on the type:

• **Water-soluble** (B vitamins, Vitamin C) — excess is usually excreted, but very high doses can cause nausea, kidney stones (Vitamin C >2g/day), or nerve damage (B6 >200mg/day)
• **Fat-soluble** (Vitamins A, D, E, K) — these accumulate in the body. Vitamin D toxicity above 10,000 IU/day long-term can cause hypercalcemia (high blood calcium)
• **Minerals** (Iron, Zinc, Magnesium) — excess iron is dangerous especially for children. High zinc depletes copper. Excess magnesium causes diarrhea

**Safe upper limits (adults):**
Vitamin D: 4,000 IU/day | Vitamin C: 2,000mg | Zinc: 40mg | Iron: 45mg | Magnesium: 350mg supplemental

If you accidentally took too much, stop, drink water, and contact a healthcare provider if you feel unwell.` + DISCLAIMER,
  },
  {
    patterns: /mix|combine|take together|same time|stack|all at once|can i take/,
    response: `💊 **Can you take supplements together?**

✅ **Safe to combine:**
• Vitamin D + K2 (synergistic — K2 directs calcium to bones)
• Magnesium + B6 (B6 enhances magnesium absorption)
• Vitamin C + Iron (C may triple iron absorption)
• Omega-3 + Vitamin E (antioxidant protection)

⚠️ **Take separately (2+ hours apart):**
• Iron and Calcium — calcium may block iron absorption
• Zinc and Iron — compete for absorption
• Thyroid medication — take alone, wait 4 hours before calcium, iron, or magnesium

🌙 **Best before bed:** Magnesium Glycinate
🌅 **Best in morning:** B12, Vitamin D, Iron (empty stomach)
🍽️ **Best with meals:** Omega-3, CoQ10, fat-soluble vitamins (A, D, E, K), Zinc` + DISCLAIMER,
  },
  {
    patterns: /store|storage|keep|refrigerat|shelf life|expire|expir/,
    response: `📦 **How to store supplements:**

• **Most capsules/tablets:** Cool, dry place away from sunlight — not the bathroom (humidity degrades them)
• **Probiotics:** Refrigerate after opening unless label says shelf-stable
• **Fish oil/Omega-3:** Refrigerate after opening to prevent oxidation (rancid oil is harmful)
• **Vitamin C:** Keep away from light and heat — degrades quickly
• **Powders:** Seal tightly after each use

⏰ Check expiry dates — expired supplements may lose potency or become harmful.`,
  },
  {
    patterns: /pregnant|pregnancy|breastfeed|nursing|trimester/,
    response: `🤰 **Supplements during pregnancy/breastfeeding**

⚠️ This system is NOT designed for pregnancy guidance. Please consult your OB-GYN.

**Generally considered safe (with doctor approval):**
• Prenatal multivitamin with methylfolate (400–800mcg)
• Iron (if deficient)
• Vitamin D (1,000–2,000 IU)
• Algae-based DHA omega-3 (200–300mg)
• Iodine (150mcg)

**Avoid during pregnancy:**
• High-dose Vitamin A (>10,000 IU) — teratogenic risk
• Ashwagandha, St. John's Wort, Valerian
• High-dose herbal supplements
• Vitamin A as retinol in high amounts

🏥 Always consult your healthcare provider before taking anything during pregnancy.` + DISCLAIMER,
  },
  {
    patterns: /child|kid|infant|toddler|teen|adolescent|young person/,
    response: `👶 **Supplements for children and teens**

⚠️ Adult doses are NOT safe for children. Always use pediatric formulations.

**Age guidelines:**
• **Under 4:** Only pediatric Vitamin D drops (400 IU). Consult pediatrician for anything else
• **4–12:** Children's multivitamin, pediatric D3 (600–1,000 IU), children's DHA (250mg)
• **13–17:** Adolescent-appropriate doses — generally 50–75% of adult doses

🏥 Always consult a pediatrician before giving supplements to children.` + DISCLAIMER,
  },
  {
    patterns: /empty stomach|with food|without food|before meal|after meal|when.*take|timing/,
    response: `🍽️ **When to take supplements**

**On empty stomach (morning):**
• Iron — food may reduce absorption significantly
• B12 — better absorbed without food
• Probiotics — before breakfast for best survival through stomach acid

**With food (required):**
• Omega-3/Fish oil — reduces fishy aftertaste and GI upset
• Fat-soluble vitamins (A, D, E, K) — need dietary fat for absorption
• CoQ10 — fat-soluble, needs food
• Zinc — prevents nausea on empty stomach
• Magnesium — can cause loose stools without food

**Before bed:**
• Magnesium Glycinate — promotes relaxation and sleep
• Melatonin — 30 minutes before target bedtime

💡 If you forget, taking a supplement with food is almost always better than skipping it.`,
  },
  {
    patterns: /how long|when.*work|notice.*result|feel.*better|take.*effect|see.*result/,
    response: `⏳ **How long until you notice results?**

Results vary by supplement and individual:

• **Magnesium** (sleep/anxiety): 1–2 weeks
• **Vitamin D** (energy/mood): 4–8 weeks to raise blood levels
• **Iron** (fatigue): 4–8 weeks to replenish stores
• **B12** (energy/nerve): 2–4 weeks for energy; months for nerve repair
• **Omega-3** (brain/heart): 8–12 weeks for measurable effects
• **Probiotics** (digestion): 1–4 weeks
• **Ashwagandha** (stress): 4–8 weeks
• **CoQ10** (energy/BP): 4–12 weeks
• **Melatonin** (sleep onset): Same night, but circadian reset takes 1–2 weeks

💡 Track your symptoms weekly. Most supplements need consistent daily use for 4–12 weeks for full benefit.`,
  },
  {
    patterns: /vegan|vegetarian|plant.based|no meat|no animal/,
    response: `🌱 **Key supplements for vegans/vegetarians**

🔴 **Critical (high deficiency risk):**
• **Vitamin B12** — found almost exclusively in animal products. Take methylcobalamin 1,000mcg daily. Deficiency causes irreversible nerve damage
• **Vitamin D3** — use lichen-derived D3 (vegan certified)
• **Omega-3 DHA+EPA** — use algae-based (the original source fish get their omega-3 from)

🟡 **Important:**
• **Iron** — plant iron (non-heme) absorbs less efficiently. Take with Vitamin C
• **Zinc** — phytates in grains reduce absorption. Consider supplementing
• **Calcium** — if not eating fortified foods
• **Iodine** — if not using iodized salt

💡 Get B12 and Vitamin D levels tested annually if vegan.` + DISCLAIMER,
  },
  {
    patterns: /safe|dangerous|harm|toxic|poison|bad for|risk|side effect/,
    response: `🛡️ **General supplement safety**

**Most supplements are safe when:**
• Taken at recommended doses
• Not combined with contraindicated medications
• Purchased from reputable, third-party tested brands (USP, NSF, Informed Sport certified)
• Appropriate for your age and health status

**Stop and consult a doctor if you experience:**
• Unusual symptoms after starting a supplement
• Yellowing of skin or eyes (possible liver stress)
• Severe GI distress or allergic reactions
• Rash, swelling, or difficulty breathing

**Always tell your doctor** about supplements — they can interact with medications and affect lab results.` + DISCLAIMER,
  },
  {
    patterns: /interact|drug.*interaction|medication.*supplement|supplement.*medication/,
    response: `⚠️ **Key supplement-drug interactions**

• **Warfarin/blood thinners** + Vitamin K, Fish oil >1g, CoQ10, Vitamin E → affects INR
• **Statins** + CoQ10 → statins deplete CoQ10; supplementation is recommended
• **SSRIs/antidepressants** + St. John's Wort, 5-HTP → serotonin syndrome risk (avoid)
• **Metformin** + B12 → metformin depletes B12; supplementation recommended
• **Levothyroxine (thyroid)** + Calcium, Iron, Magnesium → take thyroid med alone, wait 4 hours
• **ACE inhibitors** + Potassium → monitor potassium levels
• **Antibiotics** + Iron, Zinc → take 2 hours apart to avoid absorption interference

🏥 Always inform your doctor and pharmacist about all supplements you take.` + DISCLAIMER,
  },
  {
    patterns: /kidney|liver|diabetes|blood pressure|heart disease|thyroid|autoimmune/,
    response: `🏥 **Supplements and medical conditions**

**Kidney disease:** Avoid high-dose magnesium (>200mg), potassium, phosphorus, Vitamin C >500mg. Only supplement under nephrologist supervision.

**Liver disease:** Avoid high-dose Vitamin A, iron (unless deficient), and herbal supplements. Consult hepatologist.

**Diabetes:** Berberine and ALA may lower blood sugar — monitor glucose closely. Inform your doctor.

**High blood pressure:** Magnesium and CoQ10 may lower BP — monitor and inform your doctor.

**Heart disease:** Omega-3 has strong cardiovascular evidence. Always follow cardiologist guidelines.

**Thyroid disease:** Selenium supports T4→T3 conversion. Take thyroid medication 4 hours before calcium, iron, or magnesium.

🏥 All supplement decisions with chronic conditions should be reviewed by your healthcare provider.` + DISCLAIMER,
  },
  {
    patterns: /chest pain|faint|fainting|severe weakness|can't breathe|difficulty breathing|heart attack|stroke|emergency/,
    response: `🚨 **EMERGENCY WARNING**

If you are experiencing chest pain, fainting, severe weakness, difficulty breathing, or other emergency symptoms:

**Call 911 or go to your nearest emergency room immediately.**

These symptoms require immediate medical evaluation and are beyond the scope of supplement guidance.

This system does not diagnose or treat medical emergencies.`,
  },
  {
    patterns: /evidence|study|research|proof|science|clinical|pubmed|nih|mayo/,
    response: `📚 **Evidence sources used in this system**

Recommendations are informed by:

• **NIH Office of Dietary Supplements** — fact sheets on vitamins and minerals
• **PubMed / NCBI** — peer-reviewed clinical trials and meta-analyses
• **Mayo Clinic** — clinical nutrition guidelines
• **World Health Organization (WHO)** — global nutrition guidelines
• **Cochrane Reviews** — systematic reviews of supplement evidence
• **Endocrine Society** — Vitamin D and hormone guidelines
• **American Heart Association** — omega-3 and cardiovascular evidence

**Evidence quality levels used:**
🟢 Strong — Multiple RCTs or meta-analyses
🟡 Moderate — Some clinical trials, consistent observational data
🟠 Limited — Preliminary studies, traditional use with plausibility
⚪ Preventive — General nutritional adequacy, no specific therapeutic claim`,
  },
  {
    patterns: /cost|cheap|expensive|afford|budget|price|brand|quality/,
    response: `💰 **Choosing quality supplements on a budget**

**What to look for:**
• Third-party tested (USP, NSF International, Informed Sport, or ConsumerLab certified)
• Generic/store brands are often identical to name brands at lower cost
• Avoid proprietary blends — you can't verify individual doses

**Best value supplements:**
• Magnesium Glycinate — affordable, widely available, highly effective
• Vitamin D3 — very cheap, significant health impact
• Zinc Picolinate — inexpensive, highly bioavailable
• Generic fish oil — look for high EPA+DHA content per serving, not just total oil

**Avoid:** Supplements with excessive fillers, artificial colors, or unnecessary additives.`,
  },
  {
    patterns: /hello|hi|hey|help|what can you|what do you/,
    response: `👋 **Hi! I'm your supplement assistant.**

I can help with questions about:

💊 **Your recommendations** — why something was suggested, dosage, timing, interactions
📊 **What scores mean** — priority levels, severity, confidence scores
🛡️ **Safety** — side effects, safe limits, drug interactions, medical conditions
🌱 **Lifestyle** — diet, sleep, stress, hydration, exercise
📚 **Evidence** — what research supports each recommendation
⏳ **Timing** — how long until you see results, when to take each supplement

Just ask naturally — like "why was magnesium recommended?" or "what does high priority mean?"`,
  },
];

// ── Main response function ─────────────────────────────────────────────────
function getResponse(question, recs) {
  const q = (question || '').toLowerCase().trim();
  if (!q) return null;

  // Emergency check first — always respond
  const emergency = KB.find(e => e.patterns.source.includes('chest pain') && e.patterns.test(q));
  if (emergency) return emergency.response;

  // Off-topic guard
  if (isOffTopic(q)) {
    return "I'm only able to help with supplement, nutrition, and wellness-related questions. For other topics, please use a general search engine.";
  }

  // Check knowledge base
  for (const entry of KB) {
    if (entry.patterns.test(q)) return entry.response;
  }

  // Check against user's specific recommendations
  const allRecs = recs || [];
  const match = allRecs.find(r => {
    const words = r.name.toLowerCase().split(/[\s()+,]+/);
    return words.some(w => w.length > 3 && q.includes(w));
  });

  if (match) {
    if (/why|reason|recommend|suggest|trigger/.test(q)) {
      return `**${match.name}** was suggested because:\n\n${match.reason}\n\n**Triggered by:** ${match.triggeredBy || 'Your overall health profile'}\n**Confidence:** ${match.confidenceScore || 'N/A'}%${DISCLAIMER}`;
    }
    if (/dose|dosage|how much|how many|amount/.test(q)) {
      return `**${match.name} — Dosage**\n\n💊 ${match.dosage}\n⏰ **Best time:** ${match.timing}\n\n${match.sideEffects ? '⚠️ **Safe limits:** ' + match.sideEffects : ''}${DISCLAIMER}`;
    }
    if (/side effect|safe|danger|risk|harm|toxic/.test(q)) {
      return `**${match.name} — Safety**\n\n${match.sideEffects || 'Generally well tolerated at recommended doses. Discontinue if adverse reactions occur and consult a healthcare provider.'}${DISCLAIMER}`;
    }
    if (/food|eat|diet|natural|source/.test(q)) {
      return `**Natural food sources for ${match.name}:**\n\n🥗 ${match.foods || 'Obtain from a varied whole-food diet where possible.'}`;
    }
    if (/interact|medication|drug|combine|mix/.test(q)) {
      return `**${match.name} — Interactions**\n\n${match.interactions || 'None identified at recommended doses.'}\n\n💡 Always inform your doctor or pharmacist about all supplements you take.${DISCLAIMER}`;
    }
    if (/evidence|study|research|proof|science/.test(q)) {
      return `**Evidence for ${match.name}:**\n\n📚 ${match.evidence || 'Based on clinical nutrition guidelines and peer-reviewed research.'}`;
    }
    if (/when|time|morning|evening|night|meal/.test(q)) {
      return `**When to take ${match.name}:**\n\n⏰ ${match.timing}`;
    }
    return `**${match.name}** — Summary\n\n📋 **Why:** ${match.reason}\n💊 **Dosage:** ${match.dosage}\n⏰ **Timing:** ${match.timing}\n⚠️ **Interactions:** ${match.interactions || 'None identified'}\n🥗 **Food sources:** ${match.foods || 'Varied whole-food diet'}${DISCLAIMER}`;
  }

  // List questions
  if (/how many|list|all supplement|show me|what.*recommend/.test(q)) {
    if (allRecs.length === 0) return 'No supplements have been recommended yet. Complete a health assessment first to get personalized recommendations.';
    return `You have **${allRecs.length} supplements** recommended:\n\n${allRecs.map(r => `${getIcon(r.name)} **${r.name}** — ${r.priority} priority`).join('\n')}`;
  }
  if (/high priority|most important|start with|first.*take/.test(q)) {
    const high = allRecs.filter(r => r.priority === 'High');
    if (high.length === 0) return 'No high priority supplements were identified for your profile.';
    return `Your **${high.length} high-priority supplements:**\n\n${high.map(r => `${getIcon(r.name)} **${r.name}**\n   → ${r.triggeredBy || r.reason?.substring(0, 80) + '...'}`).join('\n\n')}\n\n💡 Start with these in Week 1, one at a time.`;
  }
  if (/schedule|daily.*plan|when.*take.*all/.test(q)) {
    return `**Your daily supplement schedule:**\n\n🌅 **Morning (empty stomach):** B12, Iron, Probiotics\n☀️ **With breakfast:** Vitamin D, Ashwagandha, B Complex\n🍽️ **With meals:** Omega-3, CoQ10, Zinc, fat-soluble vitamins\n🌙 **Evening (with dinner):** Magnesium Glycinate\n🌙 **Before bed (30 min):** Melatonin\n\nCheck the **Daily Schedule** section on your results page for your exact personalized timing.`;
  }
  if (/thank|thanks|great|good|helpful|awesome/.test(q)) {
    return `You're welcome! 😊 Feel free to ask anything else about your supplements or wellness.`;
  }

  return `I can help with that — try asking more specifically:\n\n• **"Why was [supplement] recommended?"**\n• **"What does high priority mean?"**\n• **"What's the dosage for magnesium?"**\n• **"What if I take too much?"**\n• **"Can I mix iron and calcium?"**\n• **"How long until I see results?"**\n• **"Is it safe with kidney disease?"**\n• **"What foods contain zinc?"**`;
}

// ── Format markdown-like text ──────────────────────────────────────────────
function formatText(text) {
  return text.split('\n').map((line, i) => {
    const html = line
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>');
    return <p key={i} dangerouslySetInnerHTML={{ __html: html || '\u00a0' }} style={{ margin: '2px 0' }} />;
  });
}

// ── Component ──────────────────────────────────────────────────────────────
export default function ChatAssistant({ recommendations }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      text: "👋 Hi! I'm your supplement assistant.\n\nAsk me anything — why a supplement was recommended, what priority levels mean, dosages, side effects, interactions, or general wellness questions.\n\nI'm available on any page, not just after your assessment.",
    },
  ]);
  const [input, setInput] = useState('');
  const bottomRef = useRef(null);

  // Pull latest recommendations from sessionStorage if not passed as prop
  const getRecs = () => {
    if (recommendations && recommendations.length) return recommendations;
    try {
      const stored = sessionStorage.getItem('latest_recommendations');
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  };

  // Store recommendations in sessionStorage when passed as prop
  useEffect(() => {
    if (recommendations && recommendations.length) {
      try {
        sessionStorage.setItem('latest_recommendations', JSON.stringify(recommendations));
      } catch {}
    }
  }, [recommendations]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  const send = (text) => {
    const q = (text || input).trim();
    if (!q) return;
    const response = getResponse(q, getRecs());
    setMessages(prev => [
      ...prev,
      { role: 'user', text: q },
      { role: 'assistant', text: response || "I couldn't find an answer to that. Try rephrasing your question." },
    ]);
    setInput('');
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const quickPrompts = [
    'What does high priority mean?',
    'What does severity mean?',
    'Can I mix supplements?',
    'How long for results?',
    'What if I take too much?',
    'Show my recommendations',
  ];

  return (
    <>
      <button
        className="chat-fab"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Close chat' : 'Open supplement assistant'}
      >
        <span className="chat-fab-icon">{open ? '✕' : '💬'}</span>
        {!open && <span className="chat-fab-label">Ask AI</span>}
      </button>

      {open && (
        <div className="chat-window" role="dialog" aria-label="Supplement Assistant">
          <div className="chat-header">
            <span>🤖 Supplement Assistant</span>
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="chat-disclaimer-banner">
            ⚕️ Educational only — not medical advice
          </div>

          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={"chat-bubble " + msg.role}>
                {formatText(msg.text)}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="chat-quick-prompts-wrap">
            <div className="chat-quick-prompts">
              {quickPrompts.map(p => (
                <button key={p} className="quick-prompt" onClick={() => send(p)}>{p}</button>
              ))}
            </div>
          </div>

          <div className="chat-input-row">
            <input
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about supplements, dosages, safety..."
              aria-label="Chat input"
            />
            <button
              className="chat-send"
              onClick={() => send()}
              disabled={!input.trim()}
              aria-label="Send"
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </>
  );
}
`;

fs.writeFileSync(dest, code, 'utf8');
console.log('Written', code.length, 'chars to', dest);
