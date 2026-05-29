const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { preprocessUserInput, sanitizeMedicalField } = require('../utils/sanitize');

const GROQ_MODEL = 'llama-3.3-70b-versatile';

router.post('/', protect, async (req, res) => {
  try {
    console.log('Groq key loaded:', process.env.GROQ_API_KEY ? 'YES' : 'NO');
    const a = req.body;

    // â”€â”€ Input length guards (prevent prompt injection via oversized fields) â”€â”€
    const TEXT_MAX = 1000;
    const SHORT_MAX = 200;
    if (a.feelingDescription && a.feelingDescription.length > TEXT_MAX)
      return res.status(400).json({ message: `Health description must be ${TEXT_MAX} characters or fewer.` });
    if (a.currentMedications && a.currentMedications.length > TEXT_MAX)
      return res.status(400).json({ message: `Current medications must be ${TEXT_MAX} characters or fewer.` });
    if (a.allergies && a.allergies.length > SHORT_MAX)
      return res.status(400).json({ message: `Allergies must be ${SHORT_MAX} characters or fewer.` });
    if (a.currentSupplements && a.currentSupplements.length > SHORT_MAX)
      return res.status(400).json({ message: `Current supplements must be ${SHORT_MAX} characters or fewer.` });
    if (a.bloodTestResults && a.bloodTestResults.length > TEXT_MAX)
      return res.status(400).json({ message: `Blood test results must be ${TEXT_MAX} characters or fewer.` });
    
    // Preprocess user text inputs
    const processedMedications = sanitizeMedicalField(a.currentMedications);
    const processedAllergies = sanitizeMedicalField(a.allergies);
    const processedSupplements = sanitizeMedicalField(a.currentSupplements);
    const processedDescription = preprocessUserInput(a.feelingDescription || '');

    let bmiNote = '';
    if (a.weight && a.height) {
      const bmi = (a.weight / ((a.height / 100) ** 2)).toFixed(1);
      const cat = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'normal weight' : bmi < 30 ? 'overweight' : 'obese';
      bmiNote = `BMI: ${bmi} (${cat})`;
    }

    // Interpret free-text fields professionally
    const noMedPhrases = /^(none|no|n\/a|nil|nothing|not taking|no meds|no medication|im not|i'm not|i am not|nope|negative|na$|not specified)/i;
    const noAllergyPhrases = /^(none|no|n\/a|nil|nothing|not allergic|no allerg|no known|nkda|nope|negative|na$|not specified)/i;
    const medsText = processedMedications && !noMedPhrases.test(processedMedications.trim())
      ? processedMedications.trim()
      : 'None reported';
    const allergiesText = processedAllergies && !noAllergyPhrases.test(processedAllergies.trim())
      ? processedAllergies.trim()
      : 'None known';
    const supplementsText = processedSupplements && processedSupplements !== 'Not specified'
      ? processedSupplements.trim()
      : 'None reported';
    const descriptionText = processedDescription && processedDescription !== '[unspecified]' && processedDescription.trim().length > 5
      ? processedDescription.trim()
      : '';

    // Build optional profile lines — only include fields the user actually answered
    const optionalLines = [];
    if (a.activityLevel) optionalLines.push(`- Activity Level: ${a.activityLevel}`);
    if (a.dietType) optionalLines.push(`- Diet Type: ${a.dietType}`);
    const _goals = a.healthGoals?.length ? a.healthGoals.join(', ') : null;
    if (_goals) optionalLines.push(`- Health Goals: ${_goals}`);
    const _activeSymptoms = (a.symptoms || []).filter(s => s !== 'No current symptoms');
    if (_activeSymptoms.length > 0) {
      const _symptomsStr = _activeSymptoms.map(s => {
        const sev = a.symptomSeverity?.[s];
        return sev ? `${s} (${sev})` : s;
      }).join(', ');
      optionalLines.push(`- Symptoms: ${_symptomsStr}`);
    }
    if (a.sleepQuality) optionalLines.push(`- Sleep Quality: ${a.sleepQuality}`);
    if (a.waterIntake) optionalLines.push(`- Daily Water Intake: ${a.waterIntake}`);
    const _activeHabits = (a.lifestyleHabits || []).filter(h => h !== 'None');
    if (_activeHabits.length > 0) optionalLines.push(`- Lifestyle Habits: ${_activeHabits.join(', ')}`);
    if (a.pregnancyStatus && a.pregnancyStatus !== 'Not applicable')
      optionalLines.push(`- Pregnancy/Breastfeeding: ${a.pregnancyStatus}`);
    if (a.takingSupplements === 'Yes') {
      optionalLines.push(`- Currently Taking Supplements: Yes — ${supplementsText}`);
    } else if (a.takingSupplements === 'No') {
      optionalLines.push(`- Currently Taking Supplements: No`);
    }
    if (a.recentBloodTest === 'Yes' && a.bloodTestResults) {
      optionalLines.push(`- Recent Blood Test Results: ${a.bloodTestResults}`);
    } else if (a.recentBloodTest === 'Yes') {
      optionalLines.push(`- Recent Blood Test: Yes (no results provided)`);
    }
    const _activeMedConditions = (a.medicalConditions || []).filter(c => c !== 'None');
    if (_activeMedConditions.length > 0) optionalLines.push(`- Medical Conditions: ${_activeMedConditions.join(', ')}`);
    if (medsText !== 'None reported') optionalLines.push(`- Current Medications: ${medsText}`);
    if (allergiesText !== 'None known') optionalLines.push(`- Known Allergies: ${allergiesText}`);
    if (a.sunExposure) optionalLines.push(`- Daily Sun Exposure: ${a.sunExposure}`);
    if (a.fitnessFocus && a.fitnessFocus !== 'Not applicable') optionalLines.push(`- Primary Fitness Focus: ${a.fitnessFocus}`);
    if (a.proteinIntake && a.proteinIntake !== 'Not sure') optionalLines.push(`- Daily Protein Intake: ${a.proteinIntake}`);
    if (descriptionText) optionalLines.push(`- Clinical Presentation: ${descriptionText}`);

    const prompt = `<s>[INST] You are an expert clinical nutritionist and integrative medicine specialist with 20 years of experience. A patient has completed a health assessment. Analyze ONLY the provided information holistically like a real doctor and provide a complete wellness plan.

IMPORTANT MEDICAL SAFETY RULES:
- Use possibility language, NOT diagnostic language. Say "may support", "some individuals find", "evidence suggests" — NOT "X causes Y" or "you have X deficiency"
- NEVER diagnose conditions. Suggest possibilities only.
- Always include safe upper limits in dosage warnings
- Flag any supplement that may interact with medications or conditions
- If symptoms suggest serious conditions (chest pain, severe depression, rapid weight loss), trigger a doctor consultation alert
- Provide exactly 20 recommendations total, prioritized by clinical relevance
CRITICAL RULES:
1. Check medications for supplement interactions (warfarin+VitK/fish oil, statins+CoQ10, SSRIs+St.John's Wort/5-HTP, metformin+B12, thyroid meds+calcium/iron timing).
2. Exclude supplements that conflict with allergies.
3. Adjust for medical conditions (kidney disease: avoid high-dose minerals; diabetes: monitor blood sugar supplements; heart disease: prioritize CoQ10/omega-3).
4. Consider ONLY the information provided — do NOT assume or invent values for fields the patient did not answer.
5. Use specific supplement forms (magnesium glycinate not oxide, methylcobalamin not cyanocobalamin).
6. The patient's own description of how they feel is the most important clinical clue.
7. Provide REAL lifestyle advice — sleep hygiene, diet changes, exercise, stress management, hydration.
8. AGE IS CRITICAL: Under 4 = pediatric only. 4-12 = pediatric doses. 13-17 = adolescent. 65+ = bone/B12/CoQ10 priority. NEVER adult doses for children.
9. BMI matters: underweight = caloric density; obese = metabolic health.
10. SEVERITY MATTERS: Severe fatigue is not the same as mild fatigue. Adjust dosage, priority, and urgency based on symptom severity.
11. PREGNANCY/BREASTFEEDING: If pregnant or breastfeeding, avoid high-dose Vitamin A, avoid herbs (ashwagandha, St. John's Wort), prioritize folate, iron, DHA, and iodine.
12. LIFESTYLE HABITS: Smoking depletes Vitamin C and antioxidants. Alcohol depletes B vitamins, magnesium, and zinc.
13. OPTIONAL FIELDS NOT PROVIDED: If an optional field was not answered, do NOT mention it, do NOT say "not provided", and do NOT base recommendations on it. Only use what is explicitly listed in the patient profile below.
14. EXPLAINABLE AI: For each recommendation, clearly state what symptom/condition/goal triggered it (triggeredBy field).
15. RULE-BASED SAFEGUARDS: IF kidney disease — avoid magnesium >200mg, avoid high-dose Vitamin C. IF on blood thinners — avoid high-dose Vitamin K, fish oil >1g.
PATIENT PROFILE (only answered fields are listed):
- Age: ${a.age}, Gender: ${a.gender}
- Weight: ${a.weight}kg, Height: ${a.height}cm${bmiNote ? ', ' + bmiNote : ''}
${optionalLines.join('\n')}
SUMMARY INSTRUCTIONS:
Write a professional clinical summary (3-4 sentences) that maintains a clinical tone at all times. You MUST:

**INPUT PROCESSING RULES:**
1. **Correct spelling automatically** - "tireed" â†’ "fatigue", "vitamen" â†’ "vitamin", "suppliment" â†’ "supplement"
2. **Convert slang to professional medical terms:**
   - "super tired" â†’ "reports significant fatigue"
   - "can't sleep" â†’ "experiencing insomnia"
   - "tummy ache" â†’ "abdominal discomfort"
   - "brain fog" â†’ "cognitive impairment"
   - "stressed out" â†’ "experiencing elevated stress levels"
3. **Convert Filipino/Tagalog terms to English medical terms:**
   - "pagod" â†’ "fatigue"
   - "nahihilo" â†’ "dizziness"
   - "naiinis" â†’ "irritability"
   - "masakit" â†’ "pain"
   - "sakit sa bata" â†’ "childhood illness history (requires clarification)"
4. **Handle food/allergy terms professionally:**
   - "sea foods" â†’ "seafood"
   - "nuts" â†’ "tree nuts and/or peanuts"
   - "diary" â†’ "dairy products"
5. **Ignore nonsense/filler words** - Remove "like", "um", "you know", repeated characters
6. **Infer intended meaning carefully** - If unclear, use neutral phrases:
   - Unclear allergy â†’ "allergy information requires clarification"
   - Vague symptom â†’ "unspecified symptoms"
   - Incomplete medication â†’ "medication history incomplete"
7. **NEVER quote raw user input verbatim** - Always paraphrase professionally
8. **Use neutral medical language** - Avoid casual, emotional, or judgmental terms
9. **Maintain professional clinical tone** - Write as a healthcare professional would document

**SUMMARY STRUCTURE:**
- Sentence 1: Patient demographics and primary presentation
- Sentence 2: Key symptoms, severity, and relevant medical history
- Sentence 3: Lifestyle factors, diet, and current health management
- Sentence 4 (if needed): Notable concerns or consultation recommendations

**LANGUAGE REQUIREMENTS:**
- Use possibility language ("may indicate", "suggests", "consistent with", "reports")
- Use complete, grammatically correct sentences
- Capitalize properly
- Paraphrase naturally - synthesize information, don't list it
- Professional medical terminology throughout

Respond with ONLY valid JSON, no markdown, no code fences:
{
  "summary": "Professional clinical summary 3-4 sentences written in natural, grammatically correct prose. ALWAYS start the first sentence with the patient's age, gender, and BMI woven naturally into the sentence — for example: 'A 22-year-old male patient with a BMI of 23.4 (normal weight) reports...' or 'A 35-year-old female patient with a BMI of 27.1, indicating overweight status, presents with...'. Use possibility language throughout. Do not quote patient verbatim. Paraphrase naturally. Write as a clinical professional would document a patient case.",
  "consultDoctor": true or false Ã¢â‚¬â€ true if symptoms suggest serious conditions needing immediate medical attention,
  "consultReason": "Reason why doctor consultation is recommended, or null",
  "recommendations": [
    {
      "name": "Specific supplement name and form",
      "reason": "Why this was selected for THIS patient using possibility language",
      "triggeredBy": "What symptom/condition/goal triggered this recommendation",
      "dosage": "Specific dosage with units and safe upper limit note",
      "timing": "Specific timing instructions",
      "priority": "High",
      "confidenceScore": 85,
      "severityLevel": "Moderate",
      "interactions": "Known interactions or 'None identified'",
      "evidence": "Brief evidence reference e.g. 'Supported by NIH studies on magnesium and sleep quality'",
      "foods": "A clean comma-separated list of 4-6 specific food names only. NO sentences, NO 'such as', NO 'are naturally rich in', NO filler phrases. Just food names. If a category must be mentioned, immediately follow it with specific examples in parentheses. Examples of correct format: 'Atlantic salmon, canned tuna, sardines, mackerel, herring, anchovies' OR 'Fatty fish (salmon, tuna, sardines, mackerel), walnuts, chia seeds, flaxseeds'. NEVER write sentences like 'X are naturally rich in Y'.",
      "sideEffects": "Common side effects at recommended dose"
    }
  ],
  "lifestyleAdvice": [
    {
      "category": "Category",
      "advice": "Specific actionable advice for this patient"
    }
  ],
  "mealRecommendations": [
    {
      "meal": "Breakfast/Lunch/Dinner/Snack",
      "suggestion": "Specific meal suggestion rich in needed nutrients"
    }
  ],
  "dailySchedule": [
    {
      "time": "Morning/With Lunch/Evening/Before Bed",
      "supplements": ["Supplement name 1", "Supplement name 2"]
    }
  ],
  "actionPlan": [
    {
      "phase": "Week 1 — Build Foundations",
      "focus": "One sentence describing the overall focus for this week based on the patient's profile",
      "steps": [
        "Start [specific supplement] for [specific reason tied to their symptoms]",
        "Specific diet or hydration action",
        "Specific movement or lifestyle action"
      ],
      "expectedChanges": [
        "Specific early improvement the patient may notice",
        "Another expected early change"
      ]
    },
    {
      "phase": "Week 2 — Improve Energy & Recovery",
      "focus": "One sentence describing the focus for week 2",
      "steps": [
        "Continue previous supplements",
        "Add [next supplement] for [reason]",
        "Specific activity or habit to add"
      ],
      "expectedChanges": [
        "Expected improvement by end of week 2",
        "Another expected change"
      ]
    },
    {
      "phase": "Weeks 3–4 — Build Sustainable Habits",
      "focus": "One sentence describing the focus for weeks 3-4",
      "steps": [
        "Continue supplement routine",
        "Specific habit or lifestyle improvement",
        "Specific sleep, diet, or exercise action"
      ],
      "expectedChanges": [
        "Expected improvement by end of week 4",
        "Another expected change"
      ]
    },
    {
      "phase": "Month 2 — Assess & Strengthen",
      "focus": "One sentence describing the month 2 focus",
      "steps": [
        "Maintain full supplement routine",
        "Specific mid-term action or check-in",
        "Consider lab work or doctor visit if symptoms persist"
      ],
      "expectedChanges": [
        "Primary symptoms should show measurable improvement",
        "What to do if improvement is not seen"
      ]
    },
    {
      "phase": "Month 3+ — Long-Term Recovery",
      "focus": "One sentence on long-term maintenance",
      "steps": [
        "Reassess supplement stack with a healthcare provider",
        "Maintain lifestyle habits established in previous weeks",
        "Specific long-term goal tied to their health profile"
      ],
      "expectedChanges": [
        "Full therapeutic effect expected by this point",
        "Long-term outcome if plan is maintained"
      ]
    }
  ],
  "warnings": ["Specific warnings based on medications/conditions"],
  "avoidList": ["Supplements to avoid and why"],
  "disclaimer": "This information is for educational and wellness purposes only and does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen."
}

Provide exactly 20 supplement recommendations total. Assign priority based on clinical relevance: most critical get High, moderately relevant get Medium, supportive/preventive get Low. Be specific and use possibility language. [/INST]`;

    // â”€â”€ Groq API call (fast, Llama 3.3 70B) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let aiResult = null;
    try {
      console.log('Calling Groq API...');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You are an expert clinical nutritionist. Always respond with valid JSON only â€” no markdown, no code fences, no extra text. Your entire response must be parseable JSON.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          max_tokens: 8000,
          temperature: 0.4,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content?.trim() || '';

        // Strip any accidental markdown fences
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          try {
            aiResult = JSON.parse(jsonMatch[0]);
            console.log('Groq result parsed successfully');
          } catch (parseErr) {
            console.warn('Groq JSON parse error:', parseErr.message);
          }
        } else {
          console.warn('No JSON found in Groq response');
        }
      } else {
        const errText = await response.text();
        console.error('Groq API error:', response.status, errText.substring(0, 200));
      }
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === 'AbortError';
      console.error(`Groq fetch ${isTimeout ? 'timeout' : 'error'}:`, fetchErr.message);
    }

    // Use AI result if valid, otherwise rule-based fallback
    if (aiResult && aiResult.recommendations) {
      return res.json(aiResult);
    }

    console.log('Using rule-based clinical fallback');
    return res.json(generateClinicalFallback(req.body));

  } catch (error) {
    console.error('Recommend route error:', error.message);
    return res.json(generateClinicalFallback(req.body));
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬ Clinical rule-based fallback Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function generateClinicalFallback(a) {
  // Helper function to check allergies
  const hasAllergy = (substance) => {
    const allergies = (a.allergies || '').toLowerCase();
    if (!allergies || allergies === 'none known' || allergies === 'not specified') return false;
    const allergyTerms = substance.toLowerCase().split('|');
    return allergyTerms.some(term => allergies.includes(term.trim()));
  };

  // Helper function to check if already taking supplement
  const alreadyTaking = (suppName) => {
    const currentSupps = (a.currentSupplements || '').toLowerCase();
    if (!currentSupps || currentSupps === 'none reported' || currentSupps === 'not specified') return false;
    const suppTerms = suppName.toLowerCase().split('|');
    return suppTerms.some(term => currentSupps.includes(term.trim()));
  };

  // Interpret blood test results
  const bloodTest = (a.recentBloodTest || '').toLowerCase();
  const bloodTestShows = {
    lowIron: /low.*iron|anemi|ferritin.*low|iron.*deficien/i.test(bloodTest),
    lowVitD: /low.*vitamin d|vitamin d.*low|d.*deficien/i.test(bloodTest),
    lowB12: /low.*b12|b12.*low|cobalamin.*low/i.test(bloodTest),
    highCholesterol: /high.*cholesterol|cholesterol.*high|hyperlipid/i.test(bloodTest),
    thyroidIssue: /thyroid|tsh|hypothyroid|hyperthyroid/i.test(bloodTest),
    normalIron: /iron.*normal|ferritin.*normal/i.test(bloodTest),
    normalVitD: /vitamin d.*normal|d.*normal/i.test(bloodTest),
    normalB12: /b12.*normal|cobalamin.*normal/i.test(bloodTest),
  };

  const recs = [];
  const symptoms = (a.symptoms || []).filter(s => s !== 'No current symptoms');
  const symptomSeverity = a.symptomSeverity || {};
  const goals = a.healthGoals || [];
  const diet = a.dietType || '';
  const conditions = a.medicalConditions?.filter(c => c !== 'None') || [];
  const meds = (a.currentMedications || '').toLowerCase();
  const allergies = (a.allergies || '').toLowerCase();
  const stressLevel = a.stressLevel || '';
  const sleepQuality = a.sleepQuality || '';
  const waterIntake = a.waterIntake || '';
  const lifestyleHabits = a.lifestyleHabits || [];
  const pregnancyStatus = a.pregnancyStatus || '';
  const isPregnant = pregnancyStatus === 'Pregnant';
  const isBreastfeeding = pregnancyStatus === 'Breastfeeding';
  const warnings = [];
  const avoidList = [];
  const lifestyleAdvice = [];
  const actionPlan = [];

  const age = Number(a.age) || 0;
  const onBloodThinner = /warfarin|coumadin|eliquis|xarelto/.test(meds);
  const onStatin = /statin|atorvastatin|simvastatin|rosuvastatin|lipitor|crestor/.test(meds);
  const onThyroid = /levothyroxine|synthroid|thyroid/.test(meds);
  const onMetformin = meds.includes('metformin');
  const onAntidepressant = /ssri|sertraline|fluoxetine|escitalopram|prozac|zoloft/.test(meds);
  const onACE = /lisinopril|enalapril|ramipril/.test(meds);

  // Ã¢â€â‚¬Ã¢â€â‚¬ Pregnancy / Breastfeeding safeguards Ã¢â€â‚¬Ã¢â€â‚¬
  const weight = Number(a.weight) || 0;
  const height = Number(a.height) || 0;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Insufficient data check Ã¢â€â‚¬Ã¢â€â‚¬
  const hasBasics = age > 0 && a.gender && weight > 0 && height > 0;
  const hasSymptomOrGoal = symptoms.length > 0 || goals.length > 0;
  const isPartialData = !hasBasics || !hasSymptomOrGoal;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Age group classification Ã¢â€â‚¬Ã¢â€â‚¬
  const isInfantToddler = age > 0 && age <= 3;
  const isChild = age >= 4 && age <= 12;
  const isTeen = age >= 13 && age <= 17;
  const isAdult = age >= 18 && age <= 64;
  const isSenior = age >= 65;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Infants/Toddlers (0-3): Do not recommend adult supplements Ã¢â€â‚¬Ã¢â€â‚¬
  if (isInfantToddler) {
    return {
      summary: `This ${age}-year-old patient is an infant or toddler. Supplement and nutritional needs at this age are highly specialized and must be managed exclusively by a pediatrician or registered dietitian. Self-supplementation is not appropriate for children under 4 years of age.`,
      recommendations: [
        {
          name: 'Vitamin D drops (pediatric)',
          reason: 'The American Academy of Pediatrics recommends 400 IU of Vitamin D daily for all breastfed infants from birth. Formula-fed infants consuming less than 1L/day of formula also require supplementation.',
          dosage: '400 IU daily (pediatric drops)',
          timing: 'Once daily, can be added to breast milk or formula',
          priority: 'High',
          interactions: 'Use only pediatric-formulated drops. Consult pediatrician before starting.'
        }
      ],
      lifestyleAdvice: [
        { category: 'Nutrition', advice: 'Breast milk or iron-fortified formula should be the primary nutrition source for infants under 12 months. Introduce solid foods around 6 months under pediatric guidance.' },
        { category: 'Medical', advice: 'All nutritional supplementation for children under 4 must be prescribed or approved by a licensed pediatrician. Do not administer adult supplements to young children.' }
      ],
      actionPlan: [
        'Consult your child\'s pediatrician before giving any supplement.',
        'Ensure regular well-child visits to monitor growth and nutritional status.',
        'Follow age-appropriate feeding guidelines from your healthcare provider.'
      ],
      warnings: ['Children under 4 years old should NOT receive adult supplement doses. Always consult a pediatrician.'],
      avoidList: ['All adult-dose supplements Ã¢â‚¬â€ dosages are unsafe for infants and toddlers'],
      disclaimer: 'These recommendations are for informational purposes only. For children under 4, all supplementation must be supervised by a licensed pediatrician.'
    };
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Children (4-12): Pediatric-appropriate only Ã¢â€â‚¬Ã¢â€â‚¬
  if (isChild) {
    warnings.push('All supplements for children aged 4-12 should be in pediatric formulations and doses. Consult a pediatrician before starting any supplement regimen.');
    recs.push({ name: 'Children\'s Multivitamin', reason: 'A complete pediatric multivitamin covers common nutritional gaps in children\'s diets, supporting healthy growth, immune function, and cognitive development.', dosage: '1 pediatric serving daily (per label)', timing: 'With breakfast', priority: 'High', interactions: 'Use age-appropriate pediatric formulation only' });
    recs.push({ name: 'Vitamin D3 (pediatric)', reason: 'Vitamin D deficiency is common in children and critical for bone development, immune function, and mood regulation. Most children do not get adequate sun exposure.', dosage: '600-1000 IU daily (pediatric)', timing: 'With a meal containing fat', priority: 'High', interactions: 'None identified at pediatric doses' });
    recs.push({ name: 'Omega-3 (children\'s DHA)', reason: 'DHA is essential for brain development and cognitive function in growing children. Supports focus, learning, and mood stability.', dosage: '250-500mg DHA daily (children\'s formulation)', timing: 'With meals', priority: 'Medium', interactions: 'None identified at pediatric doses' });
    if (symptoms.includes('Frequent Colds') || goals.includes('Boost Immunity'))
      recs.push({ name: 'Zinc (pediatric)', reason: 'Zinc supports immune function and reduces the duration of colds in children. Essential for growth and wound healing.', dosage: '5-10mg daily (pediatric dose)', timing: 'With meals', priority: 'Medium', interactions: 'Use pediatric dose only Ã¢â‚¬â€ adult doses are too high for children' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Ensure a balanced diet with fruits, vegetables, whole grains, lean protein, and dairy. Limit processed foods, sugary drinks, and excessive screen time during meals.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Children need at least 60 minutes of moderate-to-vigorous physical activity daily. Encourage outdoor play, sports, and active games to support healthy development.' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Children aged 6-12 need 9-12 hours of sleep per night. Establish a consistent bedtime routine and limit screens at least 1 hour before bed.' });
  actionPlan.push({ phase: 'Week 1 — Start Safely', focus: 'Consult pediatrician and introduce the safest foundational supplements.', supplements: ['Children Multivitamin', 'Vitamin D3 (pediatric)'], habits: ['Establish consistent meal times', 'Limit sugary snacks and drinks'], activity: ['60 minutes of active play daily', 'Outdoor activities'], expectedChanges: ['Improved appetite', 'Better energy for play'] });
  actionPlan.push({ phase: 'Week 2-3 — Monitor & Adjust', focus: 'Monitor tolerance and maintain consistent routine.', supplements: ['Continue multivitamin and Vitamin D'], habits: ['Consistent bedtime routine', 'Balanced meals with fruits and vegetables'], activity: ['Continue active play', 'Encourage sports or group activities'], expectedChanges: ['Improved sleep', 'Better mood and energy'] });
  actionPlan.push({ phase: 'Month 2 — Assess Growth & Immunity', focus: 'Evaluate immunity and energy improvements.', supplements: ['Add Omega-3 DHA if approved by pediatrician'], habits: ['Maintain all established habits'], activity: ['Maintain 60 min/day active play'], expectedChanges: ['Fewer colds or faster recovery', 'Improved focus and learning'] });
  actionPlan.push({ phase: 'Month 3+ — Long-Term Healthy Development', focus: 'Sustain healthy habits and schedule well-child visit.', supplements: ['Schedule well-child visit to check nutritional status and growth milestones'], habits: ['Annual nutritional review with pediatrician'], activity: ['Continue regular physical activity'], expectedChanges: ['Healthy growth milestones', 'Strong immune system', 'Good energy and focus for school'] });
    return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Teens (13-17): Adolescent-appropriate Ã¢â€â‚¬Ã¢â€â‚¬
  if (isTeen) {
    warnings.push('Adolescents should consult a healthcare provider before starting supplements, especially if involved in sports or taking medications.');
    // Teen-specific baseline
    recs.push({ name: 'Vitamin D3', reason: 'Adolescence is a critical period for bone density development. Vitamin D deficiency is extremely common in teenagers due to indoor lifestyles and is linked to poor mood, fatigue, and weakened immunity.', dosage: '1000-2000 IU daily', timing: 'With a meal containing fat', priority: 'High', interactions: 'None identified' });
    if (a.gender === 'Female')
      recs.push({ name: 'Iron (as Iron Bisglycinate)', reason: 'Adolescent females have significantly increased iron requirements due to menstruation. Iron deficiency is the most common nutritional deficiency in teenage girls and causes fatigue, poor concentration, and reduced athletic performance.', dosage: '18mg daily', timing: 'Morning with Vitamin C on empty stomach', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is critical during adolescent growth spurts and is commonly deficient. Supports bone development, muscle function, sleep quality, and stress management Ã¢â‚¬â€ all key concerns for teenagers.', dosage: '200-300mg daily', timing: 'Evening with dinner', priority: 'Medium', interactions: 'None identified' });
    if (symptoms.includes('Anxiety/Stress') || symptoms.includes('Brain Fog'))
      recs.push({ name: 'Omega-3 (Fish Oil or Algae)', reason: 'DHA supports brain development which continues through age 25. Particularly important for academic performance, mood stability, and reducing anxiety in adolescents.', dosage: '500-1000mg DHA+EPA daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Teenagers need 8-10 hours of sleep per night. Adolescent circadian rhythms naturally shift later, but consistent sleep schedules are critical for mental health, academic performance, and physical development.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Aim for 60 minutes of moderate-to-vigorous activity daily. Resistance training 2-3x/week supports bone density and healthy body composition during this critical growth period.' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Adolescents need increased calcium (1300mg/day), protein, and iron. Prioritize dairy or fortified alternatives, lean proteins, and iron-rich foods. Avoid skipping meals, especially breakfast.' });
  actionPlan.push({ phase: 'Week 1 — Build Foundations', focus: 'Start with the most impactful supplements for adolescent health.', supplements: ['Vitamin D3', 'Magnesium Glycinate'], habits: ['Establish consistent meal times', 'Reduce screen time before bed'], activity: ['60 minutes of moderate activity daily', 'Outdoor play or sports'], expectedChanges: ['Slight improvement in sleep', 'Reduced muscle tension'] });
  actionPlan.push({ phase: 'Week 2-3 — Support Energy & Focus', focus: 'Add targeted supplements and increase physical activity.', supplements: recs.filter(r => r.priority === 'Medium').map(r => r.name), habits: ['Increase calcium-rich foods', 'Prioritize breakfast daily'], activity: ['Add resistance training 2x/week', 'Active commuting or sports'], expectedChanges: ['Better focus and academic performance', 'Improved mood stability'] });
  actionPlan.push({ phase: 'Month 2 — Assess Progress', focus: 'Evaluate energy, mood, and sleep improvements.', supplements: ['Continue full supplement routine'], habits: ['Maintain consistent sleep schedule', 'Balanced nutrition with lean proteins and vegetables'], activity: ['Maintain 60 min/day activity'], expectedChanges: ['Measurable improvement in energy and mood', 'Better sleep quality'] });
  actionPlan.push({ phase: 'Month 3+ — Long-Term Health', focus: 'Sustain healthy habits and reassess with a healthcare provider.', supplements: ['Consult doctor to check Vitamin D and iron levels via blood test'], habits: ['Maintain all established habits', 'Annual nutritional check-up'], activity: ['Continue regular physical activity'], expectedChanges: ['Sustained energy and focus', 'Strong bone development', 'Healthy growth milestones'] });
    return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Senior (65+): Age-adjusted priorities Ã¢â€â‚¬Ã¢â€â‚¬
  if (isSenior) {
    warnings.push('Adults over 65 should consult their physician before starting supplements, as absorption, metabolism, and drug interactions change significantly with age.');
    recs.push({ name: 'Vitamin D3 + K2', reason: 'Vitamin D deficiency affects over 70% of adults over 65 and is directly linked to falls, fractures, cognitive decline, and immune dysfunction. K2 (MK-7) directs calcium to bones rather than arteries, critical for cardiovascular health in older adults.', dosage: '2000-4000 IU D3 + 100-200mcg K2 daily', timing: 'With largest meal', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin Ã¢â‚¬â€ consult doctor' : 'None identified' });
    recs.push({ name: 'Calcium Citrate', reason: 'Bone density declines accelerate after 65. Calcium citrate is better absorbed than carbonate in older adults with reduced stomach acid. Essential for fracture prevention.', dosage: '500mg twice daily (do not exceed 1200mg total)', timing: 'With meals, split into two doses', priority: 'High', interactions: onThyroid ? 'Take 4+ hours away from thyroid medication' : 'None identified' });
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'Gastric acid production declines with age, significantly reducing B12 absorption from food. Deficiency in seniors causes cognitive decline, neuropathy, and anemia Ã¢â‚¬â€ often misdiagnosed as dementia.', dosage: '1000mcg daily (sublingual preferred)', timing: 'Morning, sublingual for best absorption', priority: 'High', interactions: onMetformin ? 'Critical Ã¢â‚¬â€ metformin further depletes B12' : 'None identified' });
    recs.push({ name: 'Omega-3 (EPA+DHA)', reason: 'Strong evidence for reducing cardiovascular risk, inflammation, cognitive decline, and depression in older adults. EPA reduces inflammation while DHA protects brain structure.', dosage: '1000-2000mg EPA+DHA daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Use 1g max on blood thinners Ã¢â‚¬â€ monitor INR' : 'None identified' });
    recs.push({ name: 'CoQ10 (Ubiquinol)', reason: 'CoQ10 production declines by up to 50% by age 70. Ubiquinol (active form) supports heart function, energy production, and reduces oxidative stress. Particularly important for seniors on statins.', dosage: '100-200mg daily', timing: 'With fat-containing meal', priority: 'Medium', interactions: onStatin ? 'Essential Ã¢â‚¬â€ statins further deplete CoQ10' : 'None identified' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Resistance training 2-3x/week is the single most important intervention for healthy aging Ã¢â‚¬â€ prevents muscle loss (sarcopenia), maintains bone density, and reduces fall risk. Balance exercises like tai chi reduce falls by 45%.' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Protein needs increase with age to prevent muscle loss. Aim for 1.2-1.6g protein per kg body weight daily. Prioritize leucine-rich proteins (eggs, fish, dairy) which most effectively stimulate muscle synthesis.' });
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Thirst sensation diminishes with age, making dehydration common and dangerous in seniors. Drink 6-8 glasses of water daily regardless of thirst. Dehydration worsens cognitive function, constipation, and fall risk.' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Sleep architecture changes with age Ã¢â‚¬â€ less deep sleep, more frequent waking. Maintain consistent sleep/wake times, limit naps to 20 minutes before 3pm, and avoid alcohol which fragments sleep quality.' });
  actionPlan.push({ phase: 'Week 1 — Build Foundations', focus: 'Start with the most critical supplements for senior health.', supplements: ['Vitamin D3 + K2', 'Vitamin B12 (Methylcobalamin)'], habits: ['Drink 6-8 glasses of water daily', 'Establish consistent meal and sleep times'], activity: ['10-15 minute daily walks', 'Chair-based stretching exercises'], expectedChanges: ['Slight improvement in energy', 'Reduced fatigue'] });
  actionPlan.push({ phase: 'Week 2-3 — Support Bone & Heart Health', focus: 'Add bone and cardiovascular support supplements.', supplements: ['Calcium Citrate', 'Omega-3 (EPA+DHA)'], habits: ['Increase calcium-rich foods', 'Reduce sodium intake'], activity: ['20-30 minutes of daily movement', 'Balance exercises to reduce fall risk'], expectedChanges: ['Reduced joint stiffness', 'Improved cardiovascular comfort'] });
  actionPlan.push({ phase: 'Month 2 — Build Strength & Clarity', focus: 'Increase physical activity and assess cognitive and physical improvements.', supplements: ['Add CoQ10 if on statins', 'Continue full routine'], habits: ['Maintain consistent supplement schedule', 'Social engagement for cognitive health'], activity: ['Begin resistance training 2x/week', 'Even chair-based exercises improve strength significantly'], expectedChanges: ['Improved cognitive clarity', 'Better bone and cardiovascular health', 'Increased strength'] });
  actionPlan.push({ phase: 'Month 3+ — Long-Term Maintenance', focus: 'Sustain progress with quarterly medical check-ins.', supplements: ['Schedule quarterly review with doctor', 'Check Vitamin D, B12, and bone density labs'], habits: ['Maintain all established habits', 'Annual comprehensive health review'], activity: ['Maintain regular exercise routine'], expectedChanges: ['Sustained bone density protection', 'Stable cognitive function', 'Reduced fall risk and improved quality of life'] });
    return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Medication flags Ã¢â€â‚¬Ã¢â€â‚¬
  if (isPregnant || isBreastfeeding) {
    warnings.push(`${isPregnant ? 'Pregnancy' : 'Breastfeeding'}: Supplement needs are significantly different. Prioritize prenatal vitamins with folate (400-800mcg), iron, DHA, and iodine. Avoid high-dose Vitamin A (>10,000 IU), herbal supplements (ashwagandha, St. John's Wort, valerian), and high-dose Vitamin D without medical supervision.`);
    avoidList.push('Ashwagandha Ã¢â‚¬â€ avoid during pregnancy/breastfeeding');
    avoidList.push('St. John\'s Wort Ã¢â‚¬â€ avoid during pregnancy/breastfeeding');
    avoidList.push('High-dose Vitamin A (>10,000 IU) Ã¢â‚¬â€ teratogenic risk');
    recs.push({ name: 'Prenatal Multivitamin with Methylfolate', reason: `${isPregnant ? 'Pregnancy' : 'Breastfeeding'} significantly increases requirements for folate, iron, iodine, and DHA. A comprehensive prenatal multivitamin covers these critical needs.`, dosage: '1 serving daily per label', timing: 'With food to reduce nausea', priority: 'High', interactions: 'Use prenatal-specific formulation only' });
    recs.push({ name: 'Algae-based DHA (prenatal)', reason: 'DHA is critical for fetal brain and eye development. Algae-based DHA is the safest form during pregnancy, avoiding mercury concerns from fish oil.', dosage: '200-300mg DHA daily', timing: 'With meals', priority: 'High', interactions: 'None identified at recommended doses' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Lifestyle habit safeguards Ã¢â€â‚¬Ã¢â€â‚¬
  if (lifestyleHabits.includes('Smoking')) {
    warnings.push('Smoking significantly depletes Vitamin C, Vitamin E, and antioxidants. Higher doses of antioxidants are recommended. Smoking also increases cardiovascular risk Ã¢â‚¬â€ prioritize heart-protective supplements.');
    recs.push({ name: 'Vitamin C (as Ascorbic Acid)', reason: 'Smokers require 35mg more Vitamin C daily than non-smokers per NIH guidelines. Smoking depletes antioxidant reserves rapidly, increasing oxidative stress and cardiovascular risk.', dosage: '500-1000mg daily', timing: 'With meals, split into 2 doses', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'N-Acetyl Cysteine (NAC)', reason: 'NAC is a precursor to glutathione, the body\'s master antioxidant. Smoking depletes glutathione significantly. NAC also supports lung health and mucus clearance.', dosage: '600mg twice daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified' });
  }
  if (lifestyleHabits.includes('Alcohol')) {
    warnings.push('Regular alcohol consumption depletes B vitamins (especially B1, B6, B12, folate), magnesium, and zinc. These should be prioritized in your supplement plan.');
    if (!recs.find(r => r.name.includes('B12')))
      recs.push({ name: 'Vitamin B Complex (B1, B6, B12, Folate)', reason: 'Alcohol directly impairs absorption and increases excretion of B vitamins. Deficiency causes fatigue, neuropathy, and cognitive decline. A complete B complex addresses all alcohol-depleted B vitamins.', dosage: '1 B-complex daily', timing: 'Morning with breakfast', priority: 'High', interactions: 'None identified' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Stress level logic Ã¢â€â‚¬Ã¢â€â‚¬
  if (stressLevel === 'High' || stressLevel === 'Severe') {
    if (!recs.find(r => r.name.includes('Ashwagandha')) && !onAntidepressant && !isPregnant && !isBreastfeeding)
      recs.push({ name: 'Ashwagandha (KSM-66)', reason: `${stressLevel} stress level detected. KSM-66 ashwagandha has the strongest clinical evidence for cortisol reduction, with multiple RCTs showing 27-30% cortisol reduction and significant anxiety improvement.`, dosage: stressLevel === 'Severe' ? '600mg daily' : '300-600mg daily', timing: 'Morning or evening with food', priority: stressLevel === 'Severe' ? 'High' : 'Medium', interactions: 'None identified', triggeredBy: `${stressLevel} stress level reported` });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Chronic stress rapidly depletes magnesium stores. Magnesium is essential for the stress response and GABA activation. Glycinate form crosses the blood-brain barrier effectively.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: `${stressLevel} stress level reported` });
    lifestyleAdvice.push({ category: 'Stress Management', advice: stressLevel === 'Severe' ? 'Severe stress requires immediate intervention. Consider speaking with a mental health professional. Daily practices: 15-20 minutes of mindfulness meditation, journaling, and at least one screen-free hour. Chronic severe stress is linked to adrenal fatigue, immune suppression, and cardiovascular disease.' : 'Practice daily stress management: 10 minutes of mindfulness meditation, 4-7-8 breathing (inhale 4s, hold 7s, exhale 8s), and regular physical activity. Chronic stress depletes magnesium, B vitamins, and Vitamin C.' });
  } else if (stressLevel === 'Moderate') {
    recs.push({ name: 'L-Theanine', reason: 'Moderate stress detected. L-Theanine promotes calm alertness by increasing alpha brain waves without causing drowsiness. Particularly effective for daily stress management.', dosage: '200mg daily', timing: 'Morning or during stressful periods', priority: 'Medium', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified', triggeredBy: 'Moderate stress level reported' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Sleep quality logic Ã¢â€â‚¬Ã¢â€â‚¬
  if (sleepQuality === 'Very Poor' || sleepQuality === 'Poor') {
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: `${sleepQuality} sleep quality detected. Magnesium glycinate activates GABA receptors to quiet the nervous system. It is the most clinically studied supplement for sleep quality improvement.`, dosage: sleepQuality === 'Very Poor' ? '400mg daily' : '300-400mg daily', timing: '30-60 minutes before bed', priority: sleepQuality === 'Very Poor' ? 'High' : 'High', interactions: 'None identified', triggeredBy: `${sleepQuality} sleep quality reported` });
    recs.push({ name: 'Melatonin (low dose)', reason: `${sleepQuality} sleep quality reported. Low-dose melatonin helps reset the circadian rhythm and reduce sleep onset time. Lower doses (0.5-1mg) are more physiologically appropriate than high doses.`, dosage: '0.5Ã¢â‚¬â€œ1mg', timing: '30 minutes before target bedtime', priority: 'Medium', interactions: 'Avoid with sedatives or alcohol', triggeredBy: `${sleepQuality} sleep quality reported` });
    lifestyleAdvice.push({ category: 'Sleep', advice: sleepQuality === 'Very Poor' ? 'Very poor sleep requires a structured sleep hygiene protocol: strict consistent bedtime/wake time (even weekends), bedroom temperature 65-68Ã‚Â°F/18-20Ã‚Â°C, complete darkness, no screens 1 hour before bed, no caffeine after 1pm, and no alcohol (it fragments sleep architecture). Consider a sleep study if this persists.' : 'Improve sleep quality: consistent sleep schedule, dark and cool bedroom, avoid screens 1 hour before bed, limit caffeine after 2pm. Try 4-7-8 breathing to fall asleep faster.' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Water intake logic Ã¢â€â‚¬Ã¢â€â‚¬
  if (waterIntake === '<1L') {
    warnings.push('Very low water intake (<1L/day) detected. Chronic dehydration causes fatigue, brain fog, headaches, poor digestion, and impaired kidney function. Aim for at least 2L daily.');
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Critical: You are significantly under-hydrated. Start each morning with 500ml of water before coffee. Set hourly reminders to drink. Aim for 2-3L daily. Dehydration mimics fatigue, brain fog, and hunger Ã¢â‚¬â€ many symptoms may improve with adequate hydration alone.' });
  } else if (waterIntake === '1Ã¢â‚¬â€œ2L') {
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Your water intake is below optimal. Aim for 2-3L daily. Carry a 1L water bottle and refill it twice. Add electrolytes (sodium, potassium, magnesium) if you exercise or sweat heavily.' });
  }

  if (onBloodThinner) {
    warnings.push('IMPORTANT: You are on a blood thinner. High-dose Vitamin K, fish oil >1g, CoQ10, and Vitamin E can affect INR. Consult your doctor before any supplement.');
    avoidList.push('High-dose Vitamin K (interferes with warfarin)');
    avoidList.push('Fish oil >3g daily (bleeding risk on blood thinners)');
  }
  if (onStatin) {
    warnings.push('Statins deplete CoQ10. Supplementation is strongly recommended to prevent muscle fatigue.');
    recs.unshift({ name: 'CoQ10 (Ubiquinol)', reason: 'Statins deplete CoQ10 essential for cellular energy and heart function. Ubiquinol is the active form with superior absorption, especially for patients over 40.', dosage: '100-200mg daily', timing: 'With largest fat-containing meal', priority: 'High', interactions: 'Directly counteracts statin-induced CoQ10 depletion' });
  }
  if (onThyroid) {
    warnings.push('Levothyroxine absorption is reduced by calcium, iron, and magnesium. Take thyroid medication on empty stomach, wait 4 hours before these supplements.');
    recs.push({ name: 'Selenium (Selenomethionine)', reason: 'Essential for T4-to-T3 thyroid hormone conversion. Deficiency worsens hypothyroid symptoms. Selenomethionine is the most bioavailable form.', dosage: '100-200mcg daily', timing: 'With breakfast, 4+ hours after thyroid medication', priority: 'High', interactions: 'Safe with levothyroxine when timed correctly' });
  }
  if (onMetformin) {
    warnings.push('Metformin depletes B12 over time. B12 supplementation is clinically recommended for all long-term metformin users.');
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'Metformin blocks B12 gut absorption. Long-term deficiency causes neuropathy, fatigue, and cognitive decline. Methylcobalamin is the neurologically active form.', dosage: '1000mcg daily', timing: 'Morning with breakfast', priority: 'High', interactions: 'Counteracts metformin-induced B12 depletion' });
  }
  if (onAntidepressant) {
    warnings.push('On SSRI antidepressant: Avoid St. John\'s Wort and 5-HTP Ã¢â‚¬â€ serotonin syndrome risk. Magnesium and omega-3 are safe and beneficial.');
    avoidList.push('St. John\'s Wort (serotonin syndrome risk with SSRIs)');
    avoidList.push('5-HTP (serotonin syndrome risk with SSRIs)');
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Allergy checks Ã¢â€â‚¬Ã¢â€â‚¬
  if (/fish|seafood/.test(allergies)) avoidList.push('Fish oil / krill oil Ã¢â‚¬â€ use algae-based omega-3 instead');
  if (allergies.includes('soy')) avoidList.push('Soy-based supplements and protein powders');
  if (/gluten|celiac/.test(allergies)) warnings.push('Celiac/gluten sensitivity: Always verify supplements are certified gluten-free.');

  // Ã¢â€â‚¬Ã¢â€â‚¬ Condition-based Ã¢â€â‚¬Ã¢â€â‚¬
  if (conditions.includes('Kidney Disease')) {
    warnings.push('Kidney disease: Avoid high-dose potassium, magnesium >200mg, phosphorus, and Vitamin C >500mg. Supplement only under nephrologist supervision.');
    avoidList.push('High-dose potassium (dangerous with kidney disease)');
    avoidList.push('Magnesium >200mg (accumulates with reduced kidney function)');
    avoidList.push('Vitamin C >500mg (oxalate buildup risk)');
  }
  if (conditions.includes('Diabetes')) {
    recs.push({ name: 'Berberine', reason: 'Clinical evidence shows berberine improves insulin sensitivity comparable to metformin. Particularly beneficial for Type 2 diabetes blood glucose management.', dosage: '500mg twice daily with meals', timing: 'With breakfast and dinner', priority: 'High', interactions: 'Enhances blood sugar lowering Ã¢â‚¬â€ monitor glucose closely with doctor' });
    recs.push({ name: 'Alpha-Lipoic Acid (ALA)', reason: 'Improves insulin sensitivity and reduces diabetic neuropathy symptoms including tingling and numbness.', dosage: '600mg daily', timing: 'Before meals', priority: 'Medium', interactions: 'May lower blood sugar Ã¢â‚¬â€ monitor glucose when starting' });
    warnings.push('Diabetes: Berberine and ALA lower blood sugar. Monitor glucose closely and inform your doctor.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Follow a low-glycemic diet. Prioritize fiber-rich vegetables, legumes, and whole grains. Limit refined carbohydrates and sugary drinks. Eat smaller, more frequent meals to stabilize blood sugar.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Aim for 30 minutes of moderate exercise 5 days/week. Even a 10-minute walk after meals significantly reduces post-meal blood sugar spikes.' });
  }
  if (conditions.includes('High Blood Pressure')) {
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is common in hypertension. Relaxes blood vessel walls with clinical evidence for blood pressure reduction. Glycinate avoids digestive side effects.', dosage: '400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: onACE ? 'Safe with ACE inhibitors Ã¢â‚¬â€ monitor potassium' : 'Inform your doctor' });
    recs.push({ name: 'CoQ10', reason: 'Multiple trials show CoQ10 reduces systolic BP by 10-17 mmHg. Essential for heart muscle energy.', dosage: '100-200mg daily', timing: 'With fat-containing meal', priority: 'High', interactions: 'May enhance antihypertensive effect Ã¢â‚¬â€ monitor BP' });
    warnings.push('High blood pressure: CoQ10 and magnesium can lower BP. Monitor and inform your doctor.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Follow the DASH diet: reduce sodium to <2300mg/day, increase potassium-rich foods (bananas, sweet potatoes, spinach), limit alcohol, and avoid processed foods.' });
    lifestyleAdvice.push({ category: 'Stress', advice: 'Chronic stress directly raises blood pressure. Practice daily deep breathing (4-7-8 technique), meditation, or progressive muscle relaxation for 10-15 minutes.' });
  }
  if (conditions.includes('Heart Disease')) {
    recs.push({ name: 'Omega-3 (EPA+DHA, pharmaceutical grade)', reason: 'Strongest cardiovascular evidence of any supplement Ã¢â‚¬â€ reduces triglycerides, inflammation, and cardiac event risk.', dosage: '2000-4000mg EPA+DHA daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Use with caution on blood thinners Ã¢â‚¬â€ discuss with cardiologist' : 'Inform cardiologist' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Cardiac rehabilitation exercise is essential. Start with 20-30 minutes of low-intensity walking daily, gradually increasing. Always follow your cardiologist\'s exercise guidelines.' });
  }

  // â”€â”€ New conditions â”€â”€
  if (conditions.includes('Anemia')) {
    recs.push({ name: 'Iron Bisglycinate + Vitamin C', reason: 'Anemia reported. Iron bisglycinate is the most absorbable and gentlest form. Vitamin C co-administration triples absorption. Essential for red blood cell production.', dosage: '25-50mg iron + 500mg Vitamin C daily', timing: 'Morning on empty stomach, away from coffee/tea', priority: 'High', interactions: 'Take 4+ hours from thyroid medication if applicable', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'B12 deficiency is a common cause of megaloblastic anemia. Methylcobalamin is the neurologically active form with superior absorption.', dosage: '1000mcg daily (sublingual preferred)', timing: 'Morning', priority: 'High', interactions: 'None identified', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Folate (Methylfolate)', reason: 'Folate deficiency causes megaloblastic anemia. Methylfolate bypasses MTHFR gene variants that impair folic acid conversion.', dosage: '400-800mcg daily', timing: 'With breakfast', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Anemia reported' });
    warnings.push('Anemia: Iron supplementation should be guided by blood test results (ferritin, hemoglobin). Do not exceed 45mg iron/day without medical supervision.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat iron-rich foods with Vitamin C at every meal: spinach with lemon, lentils with tomatoes, red meat with bell peppers. Avoid coffee and tea within 1 hour of iron-rich meals as tannins block absorption by up to 60%.' });
  }
  if (conditions.includes('PCOS')) {
    recs.push({ name: 'Inositol (Myo-Inositol + D-Chiro-Inositol 40:1)', reason: 'The 40:1 ratio is the most clinically validated supplement for PCOS. Improves insulin sensitivity, restores ovulation, and reduces androgen levels.', dosage: '4g myo-inositol + 100mg D-chiro-inositol daily', timing: 'Split into 2 doses with meals', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is common in PCOS and worsens insulin resistance. Supports hormonal balance and reduces anxiety.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Vitamin D3', reason: 'Vitamin D deficiency is found in up to 85% of women with PCOS and is directly linked to insulin resistance and hormonal imbalance.', dosage: '2000-4000 IU daily', timing: 'With largest meal', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    warnings.push('PCOS: Inositol can lower blood sugar. Monitor glucose if on metformin or diabetes medications.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'A low-glycemic diet is the most evidence-based dietary intervention for PCOS. Prioritize fiber-rich vegetables, legumes, and whole grains. Reduce refined carbohydrates and sugar which spike insulin and worsen androgen levels.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Resistance training 3x/week combined with moderate cardio significantly improves insulin sensitivity in PCOS. Even 30 minutes of brisk walking daily reduces androgen levels measurably.' });
  }
  if (conditions.includes('Osteoporosis')) {
    recs.push({ name: 'Calcium Citrate + Vitamin D3 + K2', reason: 'Gold standard for osteoporosis. Calcium citrate is better absorbed than carbonate. D3 enables calcium absorption. K2 (MK-7) directs calcium into bones rather than arteries.', dosage: '500mg calcium citrate + 2000 IU D3 + 100mcg K2 daily', timing: 'With meals, split calcium into 2 doses', priority: 'High', interactions: 'K2 may interact with warfarin â€” consult doctor if on blood thinners', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for bone matrix formation and activates Vitamin D. 50-60% of total body magnesium is stored in bone.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Collagen Peptides (Type I)', reason: 'Collagen makes up 90% of bone organic matrix. Supplementation with Vitamin C stimulates osteoblast activity and has shown measurable bone density improvements in clinical trials.', dosage: '10g daily', timing: 'Morning with Vitamin C', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    warnings.push('Osteoporosis: Do not exceed 1200mg total calcium daily. Excess calcium without K2 may increase cardiovascular risk. Consult your doctor about bone density monitoring.');
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Weight-bearing exercise is the most effective non-pharmacological intervention for osteoporosis. Walking, dancing, and resistance training stimulate bone remodeling. Aim for 30 minutes of weight-bearing activity daily.' });
  }
  if (conditions.includes('Depression/Anxiety')) {
    if (!onAntidepressant) {
      recs.push({ name: 'Omega-3 (High EPA)', reason: 'EPA-dominant omega-3 has the strongest evidence for mood support. Multiple meta-analyses show significant antidepressant effects with EPA doses above 1g/day.', dosage: '1000-2000mg EPA daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
      recs.push({ name: 'Vitamin D3', reason: 'Vitamin D receptors are found throughout the brain. Low D is strongly correlated with depression and anxiety. Supplementation improves mood in deficient individuals.', dosage: '2000-4000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
    }
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for GABA and serotonin synthesis. Deficiency is found in the majority of people with anxiety and depression.', dosage: '300-400mg daily', timing: 'Evening', priority: 'High', interactions: 'Safe with SSRIs', triggeredBy: 'Depression/Anxiety reported' });
    warnings.push('Depression/Anxiety: Supplements support but do not replace professional mental health care. If symptoms are severe, please consult a psychiatrist or psychologist.');
    if (onAntidepressant) { avoidList.push("St. John's Wort â€” serotonin syndrome risk with antidepressants"); avoidList.push('5-HTP â€” serotonin syndrome risk with SSRIs/SNRIs'); }
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is as effective as antidepressants for mild-to-moderate depression. 30 minutes of moderate cardio 5x/week increases BDNF, serotonin, and dopamine.' });
  }
  if (conditions.includes('Celiac/Gluten Sensitivity')) {
    warnings.push('Celiac/Gluten Sensitivity: Always verify all supplements are certified gluten-free. Celiac disease causes malabsorption of iron, B12, folate, calcium, and Vitamin D.');
    recs.push({ name: 'Multivitamin (certified gluten-free)', reason: 'Celiac disease causes widespread nutrient malabsorption. A comprehensive gluten-free multivitamin addresses multiple simultaneous deficiencies.', dosage: '1 serving daily per label', timing: 'With breakfast', priority: 'High', interactions: 'Ensure certified gluten-free label', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    recs.push({ name: 'Iron Bisglycinate (gluten-free)', reason: 'Iron deficiency anemia is the most common presentation of celiac disease due to duodenal malabsorption.', dosage: '25mg daily', timing: 'Morning with Vitamin C', priority: 'High', interactions: 'None identified', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Strict gluten-free diet is the only treatment for celiac disease. Even trace amounts cause intestinal damage. Focus on naturally gluten-free whole foods: rice, quinoa, potatoes, meat, fish, and vegetables.' });
  }
  if (conditions.includes('Gout')) {
    avoidList.push('High-dose Niacin (raises uric acid levels)');
    avoidList.push('Vitamin C megadoses >2g (may paradoxically raise uric acid in some individuals)');
    recs.push({ name: 'Tart Cherry Extract', reason: 'Tart cherry reduces uric acid levels and gout flare frequency by up to 35% in clinical trials. Contains anthocyanins that inhibit uric acid production.', dosage: '480mg concentrated extract daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Gout reported' });
    recs.push({ name: 'Vitamin C (moderate dose)', reason: 'Vitamin C at 500-1000mg/day reduces serum uric acid by increasing renal excretion. Multiple studies confirm a 0.5mg/dL reduction per 500mg Vitamin C.', dosage: '500mg daily', timing: 'With meals', priority: 'Medium', interactions: 'Avoid megadoses >2g', triggeredBy: 'Gout reported' });
    warnings.push('Gout: Avoid high-purine foods (organ meats, anchovies, sardines, shellfish, beer). Stay well hydrated (3L+ water daily) to promote uric acid excretion.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Gout management: avoid organ meats, shellfish, red meat, and alcohol (especially beer). Increase low-fat dairy, cherries, and water. Coffee (2-4 cups/day) is associated with lower uric acid levels.' });
  }
  // Ã¢â€â‚¬Ã¢â€â‚¬ Diet-based Ã¢â€â‚¬Ã¢â€â‚¬
  // â”€â”€ New conditions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (conditions.includes('Anemia')) {
    recs.push({ name: 'Iron Bisglycinate + Vitamin C', reason: 'Anemia reported. Iron bisglycinate is the most absorbable and gentlest form. Vitamin C co-administration triples absorption. Essential for red blood cell production.', dosage: '25-50mg iron + 500mg Vitamin C daily', timing: 'Morning on empty stomach, away from coffee/tea', priority: 'High', interactions: onThyroid ? 'Take 4+ hours away from thyroid medication' : 'None identified', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'B12 deficiency is a common cause of megaloblastic anemia. Methylcobalamin is the neurologically active form with superior absorption.', dosage: '1000mcg daily (sublingual preferred)', timing: 'Morning', priority: 'High', interactions: onMetformin ? 'Critical - metformin depletes B12' : 'None identified', triggeredBy: 'Anemia reported' });
    recs.push({ name: 'Folate (Methylfolate)', reason: 'Folate deficiency causes megaloblastic anemia. Methylfolate is the active form, bypassing MTHFR gene variants that impair folic acid conversion.', dosage: '400-800mcg daily', timing: 'With breakfast', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Anemia reported' });
    warnings.push('Anemia: Iron supplementation should ideally be guided by blood test results (ferritin, hemoglobin). Do not exceed 45mg iron/day without medical supervision.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat iron-rich foods with Vitamin C at every meal: spinach with lemon, lentils with tomatoes, red meat with bell peppers. Avoid coffee and tea within 1 hour of iron-rich meals as tannins block absorption by up to 60%.' });
  }
  if (conditions.includes('PCOS')) {
    recs.push({ name: 'Inositol (Myo-Inositol + D-Chiro-Inositol 40:1)', reason: 'The 40:1 ratio is the most clinically validated supplement for PCOS. Improves insulin sensitivity, restores ovulation, and reduces androgen levels.', dosage: '4g myo-inositol + 100mg D-chiro-inositol daily', timing: 'Split into 2 doses with meals', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is common in PCOS and worsens insulin resistance. Glycinate form supports hormonal balance and reduces anxiety.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    recs.push({ name: 'Vitamin D3', reason: 'Vitamin D deficiency is found in up to 85% of women with PCOS and is directly linked to insulin resistance and hormonal imbalance.', dosage: '2000-4000 IU daily', timing: 'With largest meal', priority: 'High', interactions: 'None identified', triggeredBy: 'PCOS reported' });
    warnings.push('PCOS: Inositol and berberine can lower blood sugar. Monitor glucose if on metformin or other diabetes medications.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'A low-glycemic diet is the most evidence-based dietary intervention for PCOS. Prioritize fiber-rich vegetables, legumes, and whole grains. Reduce refined carbohydrates and sugar which spike insulin and worsen androgen levels.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Resistance training 3x/week combined with moderate cardio significantly improves insulin sensitivity in PCOS. Even 30 minutes of brisk walking daily reduces androgen levels measurably.' });
  }
  if (conditions.includes('Osteoporosis')) {
    recs.push({ name: 'Calcium Citrate + Vitamin D3 + K2', reason: 'Gold standard for osteoporosis. Calcium citrate is better absorbed than carbonate. D3 enables calcium absorption. K2 (MK-7) directs calcium into bones rather than arteries.', dosage: '500mg calcium citrate + 2000 IU D3 + 100mcg K2 daily', timing: 'With meals, split calcium into 2 doses', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin - consult doctor' : onThyroid ? 'Take 4+ hours from thyroid medication' : 'None identified', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for bone matrix formation and activates Vitamin D. 50-60% of total body magnesium is stored in bone.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    recs.push({ name: 'Collagen Peptides (Type I)', reason: 'Collagen makes up 90% of bone organic matrix. Supplementation with Vitamin C stimulates osteoblast activity and has shown measurable bone density improvements in clinical trials.', dosage: '10g daily', timing: 'Morning with Vitamin C', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Osteoporosis reported' });
    warnings.push('Osteoporosis: Do not exceed 1200mg total calcium daily (food + supplement). Excess calcium without K2 may increase cardiovascular risk. Consult your doctor about bone density monitoring.');
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Weight-bearing exercise is the most effective non-pharmacological intervention for osteoporosis. Walking, dancing, and resistance training stimulate bone remodeling. Aim for 30 minutes of weight-bearing activity daily.' });
  }
  if (conditions.includes('Depression/Anxiety')) {
    if (!onAntidepressant) {
      recs.push({ name: 'Omega-3 (High EPA)', reason: 'EPA-dominant omega-3 has the strongest evidence for mood support. Multiple meta-analyses show significant antidepressant effects with EPA doses above 1g/day.', dosage: '1000-2000mg EPA daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
      recs.push({ name: 'Vitamin D3', reason: 'Vitamin D receptors are found throughout the brain. Low D is strongly correlated with depression and anxiety. Supplementation improves mood in deficient individuals.', dosage: '2000-4000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified', triggeredBy: 'Depression/Anxiety reported' });
    }
    recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for GABA and serotonin synthesis. Deficiency is found in the majority of people with anxiety and depression.', dosage: '300-400mg daily', timing: 'Evening', priority: 'High', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified', triggeredBy: 'Depression/Anxiety reported' });
    warnings.push('Depression/Anxiety: Supplements support but do not replace professional mental health care. If symptoms are severe, please consult a psychiatrist or psychologist.');
    if (onAntidepressant) {
      avoidList.push("St. John's Wort - serotonin syndrome risk with antidepressants");
      avoidList.push('5-HTP - serotonin syndrome risk with SSRIs/SNRIs');
    }
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is as effective as antidepressants for mild-to-moderate depression. 30 minutes of moderate cardio 5x/week increases BDNF, serotonin, and dopamine.' });
  }
  if (conditions.includes('Celiac/Gluten Sensitivity')) {
    warnings.push('Celiac/Gluten Sensitivity: Always verify all supplements are certified gluten-free. Celiac disease causes malabsorption of iron, B12, folate, calcium, and Vitamin D.');
    recs.push({ name: 'Multivitamin (certified gluten-free)', reason: 'Celiac disease causes widespread nutrient malabsorption. A comprehensive gluten-free multivitamin addresses multiple simultaneous deficiencies.', dosage: '1 serving daily per label', timing: 'With breakfast', priority: 'High', interactions: 'Ensure certified gluten-free label', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    recs.push({ name: 'Iron Bisglycinate (gluten-free)', reason: 'Iron deficiency anemia is the most common presentation of celiac disease due to duodenal malabsorption.', dosage: '25mg daily', timing: 'Morning with Vitamin C', priority: 'High', interactions: onThyroid ? '4+ hours from thyroid medication' : 'None identified', triggeredBy: 'Celiac/Gluten Sensitivity reported' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Strict gluten-free diet is the only treatment for celiac disease. Focus on naturally gluten-free whole foods: rice, quinoa, potatoes, meat, fish, vegetables, and certified GF oats.' });
  }
  if (conditions.includes('Gout')) {
    avoidList.push('High-dose Niacin (raises uric acid levels)');
    avoidList.push('Vitamin C megadoses >2g (may paradoxically raise uric acid in some individuals)');
    recs.push({ name: 'Tart Cherry Extract', reason: 'Tart cherry has the strongest evidence for gout prevention - reduces uric acid levels and gout flare frequency by up to 35% in clinical trials.', dosage: '480mg concentrated extract or 240ml juice daily', timing: 'With meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Gout reported' });
    recs.push({ name: 'Vitamin C (moderate dose)', reason: 'Vitamin C at 500-1000mg/day reduces serum uric acid by increasing renal excretion. Multiple studies confirm a 0.5mg/dL reduction per 500mg Vitamin C.', dosage: '500mg daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified - avoid megadoses >2g', triggeredBy: 'Gout reported' });
    warnings.push('Gout: Avoid high-purine foods (organ meats, anchovies, sardines, shellfish, beer). Stay well hydrated (3L+ water daily) to promote uric acid excretion.');
    lifestyleAdvice.push({ category: 'Diet', advice: 'Gout management diet: avoid organ meats, shellfish, red meat, and alcohol (especially beer). Increase low-fat dairy, cherries, and water. Coffee (2-4 cups/day) is associated with lower uric acid levels.' });
  }
  // â”€â”€ New goals handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (goals.includes('Muscle Gain') || a.fitnessFocus === 'Muscle Gain') {
    recs.push({ name: 'Creatine Monohydrate', reason: 'Most researched sports supplement. Increases ATP regeneration for strength, power, and muscle recovery. Also has cognitive benefits.', dosage: '3-5g daily', timing: 'Post-workout or with any meal', priority: 'High', interactions: 'Safe for healthy kidneys. Stay well hydrated.', triggeredBy: 'Muscle Gain goal' });
    recs.push({ name: 'Whey Protein (or Plant Protein)', reason: 'Adequate protein is the primary driver of muscle protein synthesis. Supplementation helps reach the 1.6-2.2g/kg target needed for muscle gain.', dosage: '20-30g per serving, 1-2x daily', timing: 'Post-workout and/or between meals', priority: 'High', interactions: 'None identified', triggeredBy: 'Muscle Gain goal' });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is essential for muscle contraction, protein synthesis, and recovery. Deficiency impairs strength gains and increases injury risk.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Muscle Gain goal' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'For muscle gain: progressive overload resistance training 3-5x/week is essential. Increase weight or reps each session. Compound movements (squat, deadlift, bench, row) give the most muscle-building stimulus.' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Muscle gain requires a caloric surplus of 200-300 calories above maintenance. Eat 1.6-2.2g protein per kg bodyweight daily. Distribute protein across 4-5 meals for optimal muscle protein synthesis.' });
  }
  if (goals.includes('Athletic Performance') || a.fitnessFocus === 'Endurance / Cardio') {
    recs.push({ name: 'Beta-Alanine', reason: 'Increases muscle carnosine levels, buffering lactic acid during high-intensity exercise. Improves endurance performance by 2-3% in activities lasting 1-4 minutes.', dosage: '3.2-6.4g daily (split doses to reduce tingling)', timing: 'Pre-workout or with meals', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Athletic Performance goal' });
    recs.push({ name: 'Electrolyte Complex (Sodium, Potassium, Magnesium)', reason: 'Electrolyte loss during exercise impairs performance and causes cramping. A balanced electrolyte supplement maintains hydration and muscle function during training.', dosage: 'Per label, especially during/after exercise', timing: 'During and after workouts', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Athletic Performance goal' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'For athletic performance: carbohydrate timing matters. Eat 30-60g carbs 1-2 hours before training for fuel. Post-workout: 20-30g protein + 40-60g carbs within 30 minutes for optimal recovery.' });
  }
  if (goals.includes('Skin & Hair Health')) {
    recs.push({ name: 'Biotin (Vitamin B7)', reason: 'Biotin is essential for keratin production - the structural protein of hair and nails. Deficiency causes hair thinning and brittle nails.', dosage: '2500-5000mcg daily', timing: 'With breakfast', priority: 'Medium', interactions: 'May interfere with thyroid lab tests - inform your doctor', triggeredBy: 'Skin & Hair Health goal' });
    recs.push({ name: 'Collagen Peptides (Type I & III)', reason: 'Collagen provides the structural framework for skin elasticity and hair strength. Hydrolyzed peptides are absorbed and stimulate fibroblast activity.', dosage: '10g daily', timing: 'Morning with Vitamin C (enhances collagen synthesis)', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Skin & Hair Health goal' });
    if (!recs.find(r => r.name.toLowerCase().includes('omega')))
      recs.push({ name: 'Omega-3 (Fish Oil)', reason: 'Omega-3 fatty acids strengthen the skin barrier, reduce inflammation, and improve skin hydration. EPA reduces acne-causing inflammation.', dosage: '1000-2000mg EPA+DHA daily', timing: 'With meals', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Skin & Hair Health goal' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'For skin and hair health: eat foods rich in antioxidants (berries, leafy greens), healthy fats (avocado, salmon, nuts), and zinc (pumpkin seeds, oysters). Avoid excess sugar which causes glycation and accelerates skin aging.' });
  }
  if (goals.includes('Hormonal Balance')) {
    recs.push({ name: 'Ashwagandha (KSM-66)', reason: 'Ashwagandha reduces cortisol by 27-30% in clinical trials, directly improving hormonal balance. Also supports thyroid function and testosterone levels in men.', dosage: '300-600mg daily', timing: 'Morning or evening with food', priority: 'Medium', interactions: onAntidepressant ? 'Use with caution - consult doctor' : 'None identified', triggeredBy: 'Hormonal Balance goal' });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium is a cofactor in over 300 hormonal reactions. Deficiency disrupts cortisol, insulin, thyroid, and sex hormone balance.', dosage: '300-400mg daily', timing: 'Evening', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Hormonal Balance goal' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'For hormonal balance: eat adequate healthy fats (avocado, olive oil, nuts) as hormones are made from cholesterol. Avoid crash dieting which disrupts cortisol and thyroid hormones. Prioritize fiber to support estrogen metabolism.' });
  }
  if (goals.includes('Anti-Aging')) {
    recs.push({ name: 'CoQ10 (Ubiquinol)', reason: 'CoQ10 production declines with age. Ubiquinol (active form) supports mitochondrial energy production, reduces oxidative stress, and has anti-aging effects on skin and cardiovascular tissue.', dosage: '100-200mg daily', timing: 'With fat-containing meal', priority: 'Medium', interactions: onStatin ? 'Essential - statins further deplete CoQ10' : 'None identified', triggeredBy: 'Anti-Aging goal' });
    recs.push({ name: 'Resveratrol', reason: 'Activates sirtuins (longevity genes) and AMPK. Clinical evidence for cardiovascular protection, anti-inflammatory effects, and metabolic health.', dosage: '150-500mg daily', timing: 'With meals', priority: 'Low', interactions: onBloodThinner ? 'Mild blood-thinning effect - monitor' : 'None identified', triggeredBy: 'Anti-Aging goal' });
    lifestyleAdvice.push({ category: 'Lifestyle', advice: 'The most evidence-based anti-aging interventions: resistance training (preserves muscle and bone), caloric moderation (not restriction), quality sleep (cellular repair), stress management (reduces telomere shortening), and social connection.' });
  }
  // â”€â”€ Sun exposure - Vitamin D adjustment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (a.sunExposure === '< 15 min' || a.sunExposure === '15-30 min') {
    if (!recs.find(r => r.name.toLowerCase().includes('vitamin d')))
      recs.push({ name: 'Vitamin D3 + K2', reason: 'Low sun exposure reported. Vitamin D synthesis requires 15-30 minutes of midday sun on large skin areas. Supplementation is essential for those with limited sun exposure.', dosage: '2000-4000 IU D3 + 100mcg K2 daily', timing: 'With largest meal', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin' : 'None identified', triggeredBy: 'Low sun exposure reported' });
  }
  // â”€â”€ Protein intake - muscle/recovery adjustment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (a.proteinIntake === 'Very Low (< 50g)' || a.proteinIntake === 'Low (50-80g)') {
    if (!recs.find(r => r.name.toLowerCase().includes('protein')))
      recs.push({ name: 'Protein Supplement (Whey or Plant-based)', reason: 'Low protein intake reported. Adequate protein (0.8-1.6g/kg bodyweight) is essential for muscle maintenance, immune function, enzyme production, and tissue repair.', dosage: '20-30g per serving, 1-2x daily', timing: 'Between meals or post-workout', priority: 'Medium', interactions: 'None identified', triggeredBy: 'Low protein intake reported' });
    lifestyleAdvice.push({ category: 'Nutrition', advice: 'Your protein intake appears low. Aim for at least 0.8g per kg bodyweight daily (more if active). Include a protein source at every meal: eggs, meat, fish, dairy, legumes, or tofu.' });
  }
  if (['Vegan', 'Vegetarian'].includes(diet)) {
    if (!recs.find(r => r.name.includes('B12')))
      recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'B12 is found almost exclusively in animal products. Deficiency is near-universal in vegans without supplementation and causes irreversible neurological damage.', dosage: '1000mcg daily', timing: 'Morning with breakfast', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'Algae-based Omega-3 (DHA+EPA)', reason: 'Vegan source of omega-3 Ã¢â‚¬â€ algae is where fish get their DHA/EPA. Equally effective for brain function and inflammation control.', dosage: '500-1000mg DHA+EPA daily', timing: 'With fat-containing meal', priority: 'High', interactions: 'None identified' });
    recs.push({ name: 'Vitamin D3 + K2 (vegan certified)', reason: 'D3 from lichen is the vegan form. K2 (MK-7) directs calcium to bones. Both commonly deficient in plant-based diets.', dosage: '2000 IU D3 + 100mcg K2 daily', timing: 'With largest meal', priority: 'High', interactions: onBloodThinner ? 'K2 may interact with warfarin Ã¢â‚¬â€ consult doctor' : 'None identified' });
    recs.push({ name: 'Iron Bisglycinate + Vitamin C', reason: 'Plant-based iron has lower absorption. Bisglycinate is gentlest form. Vitamin C triples absorption when taken together.', dosage: '18-25mg iron + 500mg Vitamin C', timing: 'Morning on empty stomach, away from coffee', priority: 'Medium', interactions: onThyroid ? '4+ hours away from thyroid medication' : 'None identified' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Ensure adequate protein from varied plant sources: combine legumes with grains, include tofu, tempeh, seitan, and hemp seeds. Aim for 0.8-1g protein per kg body weight daily.' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Symptom-based Ã¢â€â‚¬Ã¢â€â‚¬
  if (symptoms.includes('Fatigue') || goals.includes('Increase Energy')) {
    const sev = symptomSeverity['Fatigue'] || 'Moderate';
    if (!recs.find(r => r.name.includes('B12')))
      recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: `B12 deficiency is one of the most overlooked causes of fatigue. ${sev === 'Severe' ? 'Severe fatigue warrants priority B12 supplementation.' : ''} Methylcobalamin is directly usable by the nervous system.`, dosage: sev === 'Severe' ? '2000mcg daily (sublingual)' : '1000mcg daily', timing: 'Morning', priority: sev === 'Severe' ? 'High' : 'High', interactions: onMetformin ? 'Critical Ã¢â‚¬â€ metformin depletes B12' : 'None identified', triggeredBy: `Fatigue (${sev}) reported` });
    recs.push({ name: 'Iron Bisglycinate', reason: `Iron deficiency anemia is the leading cause of fatigue, especially in women. ${sev === 'Severe' ? 'Severe fatigue may indicate significant iron deficiency.' : ''} Bisglycinate is highly absorbable without constipation.`, dosage: '18-25mg daily', timing: 'Morning on empty stomach with Vitamin C', priority: sev === 'Severe' ? 'High' : 'Medium', interactions: onThyroid ? '4+ hours from levothyroxine' : 'None identified', triggeredBy: `Fatigue (${sev}) reported` });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Fatigue is often worsened by poor sleep quality. Maintain a consistent sleep schedule (same bedtime/wake time daily), keep bedroom cool (65-68Ã‚Â°F/18-20Ã‚Â°C), and avoid screens 1 hour before bed.' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat iron-rich foods with Vitamin C: spinach with lemon juice, lentils with tomatoes. Avoid coffee/tea within 1 hour of iron-rich meals as they block absorption.' });
  }
  if (symptoms.includes('Poor Sleep') || goals.includes('Improve Sleep') || sleepQuality === 'Very Poor' || sleepQuality === 'Poor') {
    if (!recs.find(r => r.name.includes('Magnesium'))) {
      recs.push({ name: 'Magnesium Glycinate', reason: 'Activates GABA receptors to quiet the nervous system. Glycinate crosses the blood-brain barrier and is the most studied form for sleep quality.', dosage: '300-400mg daily', timing: '30-60 minutes before bed', priority: 'High', interactions: onAntidepressant ? 'Safe with antidepressants' : 'None identified', triggeredBy: 'Poor sleep reported' });
    }
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Establish a wind-down routine: dim lights 2 hours before bed, avoid caffeine after 2pm, keep a consistent sleep schedule even on weekends. Try 4-7-8 breathing (inhale 4s, hold 7s, exhale 8s) to fall asleep faster.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Regular moderate exercise improves sleep quality significantly. However, avoid intense exercise within 3 hours of bedtime as it raises cortisol and body temperature.' });
  }
  if (symptoms.includes('Brain Fog') || goals.includes('Enhance Mental Clarity')) {
    if (!allergies.includes('fish'))
      recs.push({ name: 'Omega-3 (Fish Oil, high DHA)', reason: 'DHA makes up 40% of brain fatty acids. Improves cognitive function, reduces brain fog, and protects against neurodegeneration.', dosage: '1000-2000mg DHA+EPA daily', timing: 'With meals', priority: 'Medium', interactions: onBloodThinner ? 'Use 1g max on blood thinners' : 'None identified' });
    recs.push({ name: "Lion's Mane Mushroom Extract", reason: 'Stimulates Nerve Growth Factor (NGF) production supporting neuroplasticity. Clinical trials show improvement in mild cognitive impairment.', dosage: '500-1000mg daily', timing: 'Morning with breakfast', priority: 'Medium', interactions: 'None identified' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Brain fog is often caused by blood sugar fluctuations. Eat balanced meals with protein, healthy fats, and complex carbs every 3-4 hours. Avoid skipping meals and limit refined sugar.' });
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Even mild dehydration (1-2%) significantly impairs cognitive function. Drink at least 8 glasses (2L) of water daily. Start each morning with a large glass of water before coffee.' });
  }
  if (symptoms.includes('Anxiety/Stress')) {
    if (!onAntidepressant)
      recs.push({ name: 'Ashwagandha (KSM-66)', reason: 'KSM-66 is the most clinically studied extract. Multiple RCTs show 27-30% cortisol reduction and significant anxiety improvement.', dosage: '300-600mg daily', timing: 'Morning or evening with food', priority: 'Medium', interactions: 'None identified' });
    recs.push({ name: 'L-Theanine', reason: 'Promotes alpha brain wave activity Ã¢â‚¬â€ calm alertness without sedation. Works with caffeine to reduce jitteriness. No dependency risk.', dosage: '200mg daily', timing: 'Morning or as needed', priority: 'Medium', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified' });
    lifestyleAdvice.push({ category: 'Stress', advice: 'Practice daily stress management: 10 minutes of mindfulness meditation, journaling, or deep breathing. The 4-7-8 breathing technique activates the parasympathetic nervous system within minutes.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is one of the most effective anxiety treatments. 30 minutes of moderate cardio 3-5x/week reduces cortisol and increases GABA and serotonin naturally.' });
  }
  if (symptoms.includes('Joint Pain')) {
    recs.push({ name: 'Curcumin + Piperine (or Liposomal)', reason: 'Anti-inflammatory evidence comparable to NSAIDs for joint pain without GI side effects. Must include piperine or liposomal form for absorption.', dosage: '500-1000mg curcumin + 5mg piperine daily', timing: 'With meals', priority: 'Medium', interactions: onBloodThinner ? 'Mild blood-thinning Ã¢â‚¬â€ use with caution' : 'None identified' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Low-impact exercise reduces joint pain by strengthening surrounding muscles. Try swimming, cycling, or water aerobics. Avoid high-impact activities during flare-ups. Gentle stretching and yoga improve joint mobility.' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Anti-inflammatory diet reduces joint pain: increase omega-3 rich foods (fatty fish, walnuts, flaxseed), colorful vegetables, and berries. Reduce processed foods, refined sugar, and vegetable oils high in omega-6.' });
  }
  if (symptoms.includes('Digestive Issue') || goals.includes('Digestive Health')) {
    recs.push({ name: 'Probiotic (Multi-strain, 50B CFU)', reason: 'Restores gut microbiome diversity. Key strains: L. acidophilus, B. longum, L. rhamnosus GG Ã¢â‚¬â€ the most clinically validated for digestive health.', dosage: '50 billion CFU daily', timing: 'Morning before breakfast', priority: 'Medium', interactions: 'Safe with all medications' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Feed your gut bacteria with prebiotic foods: garlic, onions, leeks, asparagus, bananas, and oats. Eat slowly and chew thoroughly. Avoid eating when stressed as it impairs digestion.' });
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Drink 2L of water daily to support digestion and prevent constipation. Warm water with lemon in the morning stimulates digestive enzymes.' });
  }
  if (symptoms.includes('Frequent Colds') || goals.includes('Boost Immunity')) {
    recs.push({ name: 'Zinc Picolinate', reason: 'Most bioavailable zinc form. Essential for T-cell immune function. Reduces cold duration and severity in clinical trials.', dosage: '15-30mg daily', timing: 'With meals to prevent nausea', priority: 'Medium', interactions: onThyroid ? '2+ hours from thyroid medication' : 'None identified' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Sleep is the most powerful immune booster. During sleep, your body produces cytokines that fight infection. Aim for 7-9 hours. Even one night of poor sleep reduces immune cell activity by 70%.' });
    lifestyleAdvice.push({ category: 'Diet', advice: 'Eat immune-supporting foods daily: citrus fruits, bell peppers (highest Vitamin C), garlic, ginger, turmeric, and fermented foods like yogurt and kefir.' });
  }
  if (symptoms.includes('Muscle Weakness') || a.activityLevel === 'Very') {
    recs.push({ name: 'Creatine Monohydrate', reason: 'Most researched sports supplement. Increases ATP regeneration for strength, power, and muscle recovery. Also has cognitive benefits.', dosage: '3-5g daily', timing: 'Post-workout or with any meal', priority: 'Medium', interactions: 'Safe for healthy kidneys' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'For muscle weakness, progressive resistance training 2-3x/week is essential. Start with bodyweight exercises and gradually increase resistance. Ensure adequate protein intake (1.6-2.2g per kg body weight) for muscle repair.' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Free-text feeling description keyword parser Ã¢â€â‚¬Ã¢â€â‚¬
  if (a.feelingDescription && a.feelingDescription.trim()) {
    const fd = a.feelingDescription.toLowerCase();

    if (/back\s*pain|backache|spine|lower back|upper back/.test(fd)) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'Back pain is frequently associated with magnesium deficiency, which causes muscle tension and spasms. Magnesium glycinate relaxes skeletal muscle and reduces pain signaling.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified' });
      recs.push({ name: 'Curcumin + Piperine', reason: 'Curcumin has strong anti-inflammatory evidence for musculoskeletal pain including back pain. Piperine is required for adequate absorption.', dosage: '500-1000mg curcumin + 5mg piperine daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Mild blood-thinning Ã¢â‚¬â€ use with caution' : 'None identified' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'For back pain, focus on core strengthening exercises (planks, bird-dogs, dead bugs) 3x/week. Weak core muscles are the primary driver of chronic back pain. Avoid prolonged sitting Ã¢â‚¬â€ stand or walk every 30 minutes.' });
      lifestyleAdvice.push({ category: 'Posture', advice: 'Poor posture is a leading cause of back pain. Ensure your workstation is ergonomically set up: monitor at eye level, feet flat on floor, lower back supported. Stretch your hip flexors and hamstrings daily as tightness pulls on the lower back.' });
    }

    if (/headache|migraine|head\s*pain|head\s*ache/.test(fd)) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'Magnesium deficiency is found in up to 50% of migraine sufferers. Clinical trials show magnesium supplementation reduces migraine frequency by 41%. It relaxes blood vessels and reduces neurological excitability.', dosage: '400mg daily', timing: 'Evening with dinner', priority: 'High', interactions: 'None identified' });
      recs.push({ name: 'Riboflavin (Vitamin B2)', reason: 'Riboflavin at high doses has strong clinical evidence for migraine prevention, reducing frequency by up to 50% in trials. It improves mitochondrial energy production in brain cells.', dosage: '400mg daily', timing: 'With breakfast', priority: 'High', interactions: 'None identified Ã¢â‚¬â€ very safe' });
      lifestyleAdvice.push({ category: 'Hydration', advice: 'Dehydration is one of the most common headache triggers. Drink at least 2-3L of water daily. Keep a water bottle visible as a reminder. Electrolyte imbalance (low sodium, magnesium) also triggers headaches.' });
      lifestyleAdvice.push({ category: 'Sleep', advice: 'Irregular sleep is a major headache trigger. Maintain consistent sleep and wake times even on weekends. Both too little and too much sleep can trigger migraines.' });
    }

    if (/knee\s*pain|knee\s*ache|knee\s*hurt/.test(fd)) {
      recs.push({ name: 'Glucosamine Sulfate + Chondroitin', reason: 'Glucosamine sulfate has the strongest evidence for knee osteoarthritis pain relief, comparable to ibuprofen in long-term trials. Chondroitin helps maintain cartilage hydration and elasticity.', dosage: '1500mg glucosamine + 1200mg chondroitin daily', timing: 'With meals, split into 2-3 doses', priority: 'High', interactions: onBloodThinner ? 'Glucosamine may mildly affect INR Ã¢â‚¬â€ monitor' : 'None identified' });
      recs.push({ name: 'Collagen Peptides (Type II)', reason: 'Type II collagen specifically targets joint cartilage. Clinical studies show it reduces knee pain and stiffness by stimulating cartilage regeneration.', dosage: '10g daily', timing: 'Morning on empty stomach with Vitamin C', priority: 'Medium', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Strengthen the muscles around the knee to reduce joint load. Focus on quad sets, straight leg raises, and step-ups. Swimming and cycling are excellent low-impact options. Avoid running on hard surfaces until pain improves.' });
    }

    if (/neck\s*pain|neck\s*stiff|stiff\s*neck/.test(fd)) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'Neck stiffness and pain are commonly caused by muscle tension from magnesium deficiency. Magnesium relaxes smooth and skeletal muscle effectively.', dosage: '300-400mg daily', timing: 'Evening', priority: 'High', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Posture', advice: 'Neck pain is often caused by forward head posture from screen use. Keep your phone at eye level, take screen breaks every 30 minutes, and do chin tucks (gently pull chin back) 10 reps hourly to strengthen deep neck flexors.' });
    }

    if (/tired|exhausted|no energy|low energy|drained|lethargic/.test(fd) && !symptoms.includes('Fatigue')) {
      if (!recs.find(r => r.name.includes('B12')))
        recs.push({ name: 'Vitamin B12 (Methylcobalamin)', reason: 'The patient reports persistent tiredness and low energy. B12 deficiency is one of the most common and overlooked causes of fatigue. Methylcobalamin is the neurologically active form with superior absorption.', dosage: '1000mcg daily', timing: 'Morning', priority: 'High', interactions: onMetformin ? 'Critical Ã¢â‚¬â€ metformin depletes B12' : 'None identified' });
      if (!recs.find(r => r.name.includes('D3')))
        recs.push({ name: 'Vitamin D3', reason: 'Low energy and fatigue are hallmark symptoms of Vitamin D deficiency, which affects over 40% of adults. Vitamin D is essential for mitochondrial energy production.', dosage: '2000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Sleep', advice: 'Persistent tiredness despite adequate sleep may indicate poor sleep quality. Evaluate sleep hygiene: consistent schedule, dark/cool room, no screens 1 hour before bed, and limit caffeine after 2pm.' });
    }

    if (/stress|overwhelm|anxious|anxiety|worried|burnout/.test(fd) && !symptoms.includes('Anxiety/Stress')) {
      if (!onAntidepressant)
        recs.push({ name: 'Ashwagandha (KSM-66)', reason: 'The patient reports stress and anxiety. KSM-66 ashwagandha has the strongest clinical evidence for cortisol reduction and stress relief among adaptogens, with multiple RCTs showing 27-30% cortisol reduction.', dosage: '300-600mg daily', timing: 'Morning or evening with food', priority: 'High', interactions: 'None identified' });
      recs.push({ name: 'L-Theanine', reason: 'L-Theanine promotes calm alertness by increasing alpha brain waves. Particularly effective for stress-related tension without causing drowsiness.', dosage: '200mg as needed', timing: 'During stressful periods or morning', priority: 'Medium', interactions: onAntidepressant ? 'Safe with SSRIs' : 'None identified' });
      lifestyleAdvice.push({ category: 'Stress', advice: 'For burnout and chronic stress, implement daily recovery practices: 10-minute morning meditation, journaling before bed, and at least one screen-free hour daily. Chronic stress depletes magnesium, B vitamins, and Vitamin C Ã¢â‚¬â€ all addressed in your supplement plan.' });
    }

    if (/sleep|insomnia|can't sleep|cant sleep|wake up|waking up|restless/.test(fd) && !symptoms.includes('Poor Sleep')) {
      if (!recs.find(r => r.name.includes('Magnesium')))
        recs.push({ name: 'Magnesium Glycinate', reason: 'The patient reports sleep difficulties. Magnesium glycinate activates GABA receptors to quiet the nervous system and is the most clinically studied supplement for sleep quality improvement.', dosage: '300-400mg daily', timing: '30-60 minutes before bed', priority: 'High', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Sleep', advice: 'For insomnia: keep a strict sleep schedule (same time every day), use your bed only for sleep, get bright light exposure in the morning to reset your circadian rhythm, and avoid alcohol which fragments sleep architecture.' });
    }

    if (/digest|bloat|stomach|gut|constipat|diarrhea|ibs|acid|reflux|nausea/.test(fd) && !symptoms.includes('Digestive Issue')) {
      if (!recs.find(r => r.name.includes('Probiotic')))
        recs.push({ name: 'Probiotic (Multi-strain, 50B CFU)', reason: 'The patient reports digestive discomfort. A high-potency multi-strain probiotic restores gut microbiome balance, reduces bloating, and improves bowel regularity.', dosage: '50 billion CFU daily', timing: 'Morning before breakfast', priority: 'High', interactions: 'Safe with all medications' });
      recs.push({ name: 'Digestive Enzymes (broad-spectrum)', reason: 'Digestive enzyme deficiency causes bloating, gas, and incomplete nutrient absorption. A broad-spectrum enzyme supplement containing amylase, protease, and lipase improves digestion of all macronutrients.', dosage: '1-2 capsules per meal', timing: 'At the start of each meal', priority: 'Medium', interactions: 'None identified' });
      lifestyleAdvice.push({ category: 'Diet', advice: 'For digestive issues: eat slowly and chew thoroughly (20+ chews per bite), avoid drinking large amounts of water with meals as it dilutes digestive enzymes, and identify trigger foods by keeping a food diary.' });
    }

    if (/weight|fat|overweight|obese|slim|thin|lose weight|gain weight/.test(fd)) {
      lifestyleAdvice.push({ category: 'Nutrition', advice: 'For weight management, focus on protein at every meal (it increases satiety by 30%), eat fiber-rich vegetables to fill up on fewer calories, and avoid liquid calories (sodas, juices, alcohol). Meal timing matters Ã¢â‚¬â€ avoid eating within 3 hours of bedtime.' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Combine cardio (150 min/week) with resistance training (2-3x/week) for optimal body composition. Resistance training builds muscle which increases resting metabolic rate, burning more calories even at rest.' });
    }

    if (/depress|sad|low mood|mood|unhappy|hopeless/.test(fd)) {
      if (!onAntidepressant) {
        recs.push({ name: 'Omega-3 (high EPA)', reason: 'EPA-dominant omega-3 has the strongest evidence for mood support among supplements. Multiple meta-analyses show significant antidepressant effects, particularly with EPA doses above 1g/day.', dosage: '1000-2000mg EPA daily', timing: 'With meals', priority: 'High', interactions: onBloodThinner ? 'Use 1g max on blood thinners' : 'None identified' });
        recs.push({ name: 'Vitamin D3', reason: 'Low Vitamin D is strongly correlated with depression. Vitamin D receptors are found throughout the brain and it plays a key role in serotonin synthesis.', dosage: '2000-4000 IU daily', timing: 'With a fat-containing meal', priority: 'High', interactions: 'None identified' });
      }
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Exercise is one of the most evidence-based interventions for depression Ã¢â‚¬â€ as effective as antidepressants in mild-to-moderate cases. Aim for 30 minutes of moderate cardio 5x/week. Even a 10-minute walk improves mood immediately.' });
      warnings.push('If you are experiencing persistent low mood or depression, please consult a mental health professional. Supplements support but do not replace professional mental health care.');
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ BMI-aware advice for adults Ã¢â€â‚¬Ã¢â€â‚¬
  if (weight > 0 && height > 0) {
    const bmi = weight / ((height / 100) ** 2);
    if (bmi < 18.5) {
      lifestyleAdvice.push({ category: 'Nutrition', advice: 'Your BMI indicates you are underweight. Focus on calorie-dense, nutrient-rich foods: nuts, avocados, whole grains, lean proteins, and healthy oils. Aim for 3 meals and 2-3 snacks daily. Consider a high-quality protein supplement if appetite is poor.' });
      recs.push({ name: 'High-Calorie Protein Supplement (Whey or Plant)', reason: 'Underweight individuals often have difficulty meeting caloric and protein needs through diet alone. Protein supplementation supports muscle mass maintenance and healthy weight gain.', dosage: '20-30g protein per serving, 1-2x daily', timing: 'Between meals or post-exercise', priority: 'Medium', interactions: 'None identified' });
    } else if (bmi >= 30) {
      lifestyleAdvice.push({ category: 'Nutrition', advice: 'Your BMI indicates obesity, which increases risk for diabetes, heart disease, and joint problems. Focus on a whole-food, high-fiber diet. Reduce ultra-processed foods, sugary beverages, and refined carbohydrates. A Mediterranean-style diet has the strongest evidence for sustainable weight management.' });
      lifestyleAdvice.push({ category: 'Exercise', advice: 'Start with low-impact exercise to protect joints: walking, swimming, or cycling. Aim for 30 minutes daily, 5 days/week. Even modest weight loss of 5-10% significantly reduces cardiovascular and metabolic risk.' });
      if (!recs.find(r => r.name.includes('Berberine')) && !conditions.includes('Diabetes'))
        recs.push({ name: 'Berberine', reason: 'Berberine improves insulin sensitivity and supports healthy weight management by activating AMPK, the body\'s metabolic master switch. Clinical trials show modest but meaningful weight reduction alongside metabolic improvements.', dosage: '500mg twice daily with meals', timing: 'With breakfast and dinner', priority: 'Medium', interactions: 'Monitor blood sugar if on diabetes medications' });
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ General lifestyle if not enough specific advice Ã¢â€â‚¬Ã¢â€â‚¬
  if (lifestyleAdvice.length < 3) {
    lifestyleAdvice.push({ category: 'Hydration', advice: 'Drink 2-3 liters of water daily. Dehydration causes fatigue, brain fog, headaches, and poor digestion. Start each morning with 500ml of water before coffee or food.' });
    lifestyleAdvice.push({ category: 'Sleep', advice: 'Prioritize 7-9 hours of quality sleep. Sleep is when your body repairs, detoxifies, and consolidates memory. Consistent sleep and wake times regulate your circadian rhythm.' });
    lifestyleAdvice.push({ category: 'Exercise', advice: 'Aim for 150 minutes of moderate exercise per week. Even 30-minute daily walks reduce all-cause mortality by 35%, improve mood, and support metabolic health.' });
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Action plan Ã¢â€â‚¬Ã¢â€â‚¬
  actionPlan.push({ phase: 'Week 1 — Build Foundations', focus: 'Introduce the most critical supplements and establish basic healthy habits.', supplements: recs.filter(r => r.priority === 'High').slice(0,2).map(r => r.name), habits: ['Improve hydration (6-8 glasses of water daily)', 'Establish a consistent sleep schedule', 'Reduce sugary drinks and processed foods'], activity: ['10-15 minute daily walks', 'Light stretching or mobility exercises'], expectedChanges: ['Slight improvement in sleep quality', 'Reduced muscle tension', 'Small increase in energy'] });
  actionPlan.push({ phase: 'Week 2 — Improve Energy & Recovery', focus: 'Add remaining high-priority supplements and increase daily movement.', supplements: recs.filter(r => r.priority === 'High').slice(2).map(r => r.name), habits: ['Increase protein and whole foods intake', 'Track symptoms daily to note improvements'], activity: ['20-30 minutes of daily movement', 'Light resistance or bodyweight exercises'], expectedChanges: ['Better daytime energy', 'Improved recovery and focus', 'Reduced sluggishness'] });
  actionPlan.push({ phase: 'Weeks 3-4 — Build Sustainable Habits', focus: 'Add medium-priority supplements and focus on consistency.', supplements: recs.filter(r => r.priority === 'Medium').map(r => r.name), habits: ['Improve meal consistency and portion control', 'Prioritize sleep hygiene: less screen time before bed, regular bedtime'], activity: ['Maintain regular exercise routine', 'Add one new physical activity you enjoy'], expectedChanges: ['Better stamina', 'Improved sleep quality', 'Better mood and physical comfort'] });
  actionPlan.push({ phase: 'Month 2 — Assess Progress', focus: 'Evaluate improvements and refine your routine based on how your body has responded.', supplements: ['Continue full supplement routine consistently'], habits: ['Review which habits are working and double down on them', 'Address any remaining symptoms with targeted changes'], activity: ['Increase exercise intensity or duration gradually'], expectedChanges: ['Noticeable improvement in primary symptoms', 'More stable energy throughout the day', 'Improved overall wellbeing'] });
  actionPlan.push({ phase: 'Month 3+ — Long-Term Recovery', focus: 'Sustain progress and reassess with a healthcare provider for long-term optimization.', supplements: ['Reassess supplement stack with a healthcare provider', 'Check relevant lab values (Vitamin D, B12, iron if applicable)'], habits: ['Maintain all established healthy habits', 'Schedule a check-in with your doctor to review progress'], activity: ['Maintain consistent exercise routine', 'Consider adding strength training if not already included'], expectedChanges: ['Full therapeutic effect of supplements reached', 'Sustained symptom relief', 'Long-term health improvements consolidated'] });

  // Ã¢â€â‚¬Ã¢â€â‚¬ Minimum supplements Ã¢â€â‚¬Ã¢â€â‚¬
  if (recs.length < 4) {
    if (!recs.find(r => r.name.includes('D3')))
      recs.push({ name: 'Vitamin D3 + K2', reason: 'Deficiency affects 40%+ of adults. Linked to fatigue, immune dysfunction, mood disorders, and bone loss. K2 directs calcium to bones.', dosage: '2000 IU D3 + 100mcg K2 daily', timing: 'With largest meal', priority: 'Medium', interactions: onBloodThinner ? 'K2 may interact with warfarin' : 'None identified' });
    if (!recs.find(r => r.name.includes('Magnesium')))
      recs.push({ name: 'Magnesium Glycinate', reason: 'Involved in 300+ enzymatic reactions. Deficiency linked to fatigue, cramps, poor sleep, anxiety, and cardiovascular issues. Glycinate is best-tolerated form.', dosage: '300-400mg daily', timing: 'Evening with dinner', priority: 'Medium', interactions: 'None identified' });
  }

  return buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Shared result builder Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function buildResult(a, recs, lifestyleAdvice, actionPlan, warnings, avoidList, conditions, symptoms, goals) {
  const noMedPhrases = /^(none|no|n\/a|nil|nothing|not taking|no meds|no medication|im not|i'm not|i am not|nope|negative|na$)/i;
  const noAllergyPhrases = /^(none|no|n\/a|nil|nothing|not allergic|no allerg|no known|nkda|nope|negative|na$)/i;

  const hasMeds = a.currentMedications && a.currentMedications.trim() && !noMedPhrases.test(a.currentMedications.trim());
  const hasAllergies = a.allergies && a.allergies.trim() && !noAllergyPhrases.test(a.allergies.trim());

  const agePart = a.age ? `${a.age}-year-old` : null;
  const genderPart = a.gender ? a.gender.toLowerCase() : null;
  let opening = [agePart, genderPart].filter(Boolean).join(' ') || 'patient';
  opening = `A ${opening} patient`;

  let bmiLine = '';
  if (a.weight && a.height) {
    const bmi = (a.weight / ((a.height / 100) ** 2)).toFixed(1);
    const bmiCat = bmi < 18.5 ? 'underweight' : bmi < 25 ? 'normal weight' : bmi < 30 ? 'overweight' : 'obese';
    const bmiStatus = bmi < 18.5 ? 'indicating underweight status' : bmi < 25 ? 'within the normal weight range' : bmi < 30 ? 'indicating overweight status' : 'indicating obesity';
    bmiLine = `with a BMI of ${bmi}, ${bmiStatus},`;
  }
  opening = bmiLine ? `${opening} ${bmiLine}` : `${opening}`;

  // Partial data notice
  const hasBasics = a.age && a.gender && a.weight && a.height;
  const hasSymptomOrGoal = symptoms.length > 0 || goals.length > 0;
  const isPartialData = !hasBasics || !hasSymptomOrGoal;
  const partialNotice = isPartialData
    ? 'Note: Incomplete health profile provided. More information is needed for fully personalized recommendations. The following suggestions are based on available data and carry lower confidence. '
    : '';

  const conditionSentence = conditions.length
    ? `Medical history is notable for ${conditions.join(' and ')}.`
    : 'No significant medical history reported.';

  const medSentence = hasMeds
    ? `Current medications include ${a.currentMedications.trim()}. Supplement recommendations have been reviewed for potential drug interactions.`
    : 'Patient is not currently taking any prescription medications.';

  const allergySentence = hasAllergies
    ? `Known allergies: ${a.allergies.trim()}.`
    : 'No known drug or food allergies reported.';

  // New fields in summary
  const stressSentence = a.stressLevel ? `Reported stress level: ${a.stressLevel}.` : '';
  const sleepSentence = a.sleepQuality ? `Sleep quality: ${a.sleepQuality}.` : '';
  const lifestyleSentence = a.lifestyleHabits?.filter(h => h !== 'None').length
    ? `Lifestyle factors noted: ${a.lifestyleHabits.filter(h => h !== 'None').join(', ')}.`
    : '';
  const pregnancySentence = (a.pregnancyStatus && a.pregnancyStatus !== 'Not applicable')
    ? `Pregnancy/breastfeeding status: ${a.pregnancyStatus}.`
    : '';

  let complaintSentence = '';
  const filteredSymptoms = symptoms.filter(s => s !== 'No current symptoms');
  if (filteredSymptoms.length && goals.length) complaintSentence = `reports ${filteredSymptoms.join(', ')}, with wellness goals focused on ${goals.join(', ')}.`;
  else if (filteredSymptoms.length) complaintSentence = `reports ${filteredSymptoms.join(', ')}.`;
  else if (goals.length) complaintSentence = `presents with wellness goals including ${goals.join(', ')}.`;

  let feelingSentence = '';
  if (a.feelingDescription && a.feelingDescription.trim() && !noMedPhrases.test(a.feelingDescription.trim())) {
    const raw = a.feelingDescription.trim().replace(/^["']|["']$/g, '');
    const normalized = raw
      .replace(/\bi\s+feel\b/gi, 'The patient reports feeling')
      .replace(/\bi\s+have\b/gi, 'The patient has')
      .replace(/\bi\s+am\b/gi, 'The patient is')
      .replace(/\bi\s+experience\b/gi, 'The patient experiences')
      .replace(/\bmy\b/gi, 'their')
      .replace(/\bi\b/gi, 'the patient');
    feelingSentence = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    if (!feelingSentence.endsWith('.')) feelingSentence += '.';
  }

  const summary = [
    partialNotice,
    `${opening} ${complaintSentence}`,
    conditionSentence, medSentence, allergySentence,
    stressSentence, sleepSentence, lifestyleSentence, pregnancySentence,
    feelingSentence,
    'The following evidence-based wellness plan addresses targeted supplementation alongside lifestyle modifications to support overall health improvement.'
  ].filter(Boolean).join(' ');

  // Ã¢â€â‚¬Ã¢â€â‚¬ Consult doctor triggers Ã¢â€â‚¬Ã¢â€â‚¬
  const fd = (a.feelingDescription || '').toLowerCase();
  const consultTriggers = [
    { test: /chest\s*pain|heart\s*attack|palpitation/.test(fd), reason: 'Reported chest pain or heart-related symptoms require immediate medical evaluation.' },
    { test: /rapid\s*weight\s*loss|losing weight fast|unexplained weight/.test(fd), reason: 'Unexplained rapid weight loss should be evaluated by a physician.' },
    { test: /suicid|self.harm|hopeless|want to die/.test(fd), reason: 'Reported mental health crisis symptoms require immediate professional support.' },
    { test: symptoms.includes('Anxiety/Stress') && conditions.length > 1, reason: 'Multiple medical conditions combined with anxiety symptoms warrant physician oversight.' },
    { test: conditions.includes('Heart Disease') || conditions.includes('Kidney Disease'), reason: 'Your medical conditions require physician supervision before starting any supplement regimen.' },
  ];
  const triggered = consultTriggers.find(t => t.test);
  const consultDoctor = !!triggered;
  const consultReason = triggered?.reason || null;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Enrich recs with new fields Ã¢â€â‚¬Ã¢â€â‚¬
  const enrichedRecs = recs.slice(0, 7).map(rec => ({
    ...rec,
    triggeredBy: rec.triggeredBy || inferTriggeredBy(rec.name, symptoms, goals, conditions, a),
    confidenceScore: rec.confidenceScore || inferConfidence(rec.name, symptoms, goals, conditions, a),
    severityLevel: rec.severityLevel || inferSeverity(rec.priority, symptoms, a),
    evidence: rec.evidence || inferEvidence(rec.name),
    foods: rec.foods || inferFoods(rec.name),
    sideEffects: rec.sideEffects || inferSideEffects(rec.name),
  }));

  // Ã¢â€â‚¬Ã¢â€â‚¬ Meal recommendations Ã¢â€â‚¬Ã¢â€â‚¬
  const mealRecommendations = buildMealRecs(symptoms, goals, conditions, a);

  // Ã¢â€â‚¬Ã¢â€â‚¬ Daily schedule Ã¢â€â‚¬Ã¢â€â‚¬
  const dailySchedule = buildDailySchedule(enrichedRecs);

  return {
    summary,
    consultDoctor,
    consultReason,
    recommendations: enrichedRecs,
    lifestyleAdvice: lifestyleAdvice.slice(0, 6),
    mealRecommendations,
    dailySchedule,
    actionPlan,
    warnings: warnings.length ? warnings : ['Always inform your healthcare provider about supplements, especially with chronic conditions or prescription medications.'],
    avoidList: avoidList.length ? avoidList : [],
    disclaimer: 'This information is for educational and wellness purposes only and does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen, especially if you have existing medical conditions or take prescription medications.',
  };
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: infer what triggered a recommendation Ã¢â€â‚¬Ã¢â€â‚¬
function inferTriggeredBy(name, symptoms, goals, conditions, a) {
  const n = name.toLowerCase();
  if (n.includes('b12')) return symptoms.includes('Fatigue') ? 'Reported fatigue' : 'Nutritional support';
  if (n.includes('magnesium')) return symptoms.includes('Poor Sleep') ? 'Poor sleep reported' : symptoms.includes('Anxiety/Stress') ? 'Anxiety/stress reported' : 'General wellness';
  if (n.includes('omega')) return symptoms.includes('Brain Fog') ? 'Brain fog reported' : goals.includes('Support Heart Health') ? 'Heart health goal' : 'Anti-inflammatory support';
  if (n.includes('vitamin d')) return 'General deficiency prevention';
  if (n.includes('iron')) return symptoms.includes('Fatigue') ? 'Fatigue and possible low iron' : 'Nutritional support';
  if (n.includes('zinc')) return symptoms.includes('Frequent Colds') ? 'Frequent illness reported' : 'Immune support goal';
  if (n.includes('ashwagandha') || n.includes('theanine')) return 'Stress/anxiety reported';
  if (n.includes('probiotic')) return symptoms.includes('Digestive Issue') ? 'Digestive issues reported' : 'Gut health goal';
  if (n.includes('coq10')) return conditions.includes('High Blood Pressure') ? 'High blood pressure' : 'Cardiovascular support';
  if (n.includes('curcumin')) return symptoms.includes('Joint Pain') ? 'Joint pain reported' : 'Anti-inflammatory support';
  return 'Based on overall health profile';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: infer confidence score Ã¢â€â‚¬Ã¢â€â‚¬
function inferConfidence(name, symptoms, goals, conditions, a) {
  const n = name.toLowerCase();
  const sev = a?.symptomSeverity || {};
  // High confidence when directly matching a symptom with severity
  if (n.includes('magnesium') && symptoms.includes('Poor Sleep')) return sev['Poor Sleep'] === 'Severe' ? 95 : 92;
  if (n.includes('b12') && symptoms.includes('Fatigue')) return sev['Fatigue'] === 'Severe' ? 92 : 88;
  if (n.includes('omega') && symptoms.includes('Brain Fog')) return sev['Brain Fog'] === 'Severe' ? 90 : 85;
  if (n.includes('ashwagandha') && symptoms.includes('Anxiety/Stress')) return sev['Anxiety/Stress'] === 'Severe' ? 92 : 87;
  if (n.includes('probiotic') && symptoms.includes('Digestive Issue')) return 90;
  if (n.includes('zinc') && symptoms.includes('Frequent Colds')) return 86;
  if (n.includes('curcumin') && symptoms.includes('Joint Pain')) return sev['Joint Pain'] === 'Severe' ? 90 : 84;
  if (n.includes('iron') && symptoms.includes('Fatigue')) return 80;
  if (n.includes('coq10') && conditions.includes('High Blood Pressure')) return 89;
  // Stress/sleep-triggered
  if (n.includes('ashwagandha') && (a?.stressLevel === 'High' || a?.stressLevel === 'Severe')) return 88;
  if (n.includes('magnesium') && (a?.sleepQuality === 'Very Poor' || a?.sleepQuality === 'Poor')) return 91;
  if (n.includes('melatonin') && (a?.sleepQuality === 'Very Poor' || a?.sleepQuality === 'Poor')) return 82;
  // Medium confidence for general recommendations
  if (n.includes('vitamin d')) return 78;
  if (n.includes('omega')) return 75;
  // Lower confidence for partial data
  if (!a?.age || !a?.gender) return 60;
  return 72;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: infer severity level Ã¢â€â‚¬Ã¢â€â‚¬
function inferSeverity(priority, symptoms, a) {
  const sev = a?.symptomSeverity || {};
  const sevValues = Object.values(sev);
  if (sevValues.includes('Severe')) return 'Severe';
  if (sevValues.includes('Moderate')) return 'Moderate';
  if (priority === 'High' && symptoms.length >= 3) return 'Moderate';
  if (priority === 'High') return 'Mild to Moderate';
  if (priority === 'Medium') return 'Mild';
  return 'Preventive';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: infer evidence reference Ã¢â€â‚¬Ã¢â€â‚¬
function inferEvidence(name) {
  const n = name.toLowerCase();
  if (n.includes('magnesium')) return 'Supported by NIH studies on magnesium and sleep quality (PMID: 23853635) and multiple RCTs on magnesium deficiency.';
  if (n.includes('b12')) return 'Supported by NIH Office of Dietary Supplements guidelines on B12 and neurological function.';
  if (n.includes('omega') || n.includes('fish oil')) return 'Supported by American Heart Association guidelines and PubMed meta-analyses on omega-3 and cardiovascular/cognitive health.';
  if (n.includes('vitamin d')) return 'Supported by Endocrine Society guidelines and NIH studies on Vitamin D deficiency prevalence and health outcomes.';
  if (n.includes('ashwagandha')) return 'Supported by double-blind RCTs published in Medicine (2019) showing 27% cortisol reduction with KSM-66 extract.';
  if (n.includes('zinc')) return 'Supported by Cochrane Review on zinc and immune function, and Mayo Clinic guidelines on zinc for cold prevention.';
  if (n.includes('probiotic')) return 'Supported by World Gastroenterology Organisation guidelines and PubMed meta-analyses on probiotics and gut health.';
  if (n.includes('coq10')) return 'Supported by meta-analysis in Journal of Human Hypertension showing 10-17 mmHg BP reduction with CoQ10.';
  if (n.includes('curcumin')) return 'Supported by systematic review in Journal of Medicinal Food on curcumin and inflammatory joint conditions.';
  if (n.includes('iron')) return 'Supported by WHO guidelines on iron deficiency and NIH Office of Dietary Supplements iron fact sheet.';
  if (n.includes('lion')) return 'Supported by clinical trial in Phytotherapy Research (2009) on Lion\'s Mane and cognitive function.';
  if (n.includes('berberine')) return 'Supported by meta-analysis in Evidence-Based Complementary Medicine on berberine and blood glucose regulation.';
  return 'Based on clinical nutrition guidelines and peer-reviewed research.';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: infer food sources Ã¢â€â‚¬Ã¢â€â‚¬
function inferFoods(name) {
  const n = name.toLowerCase();
  if (n.includes('magnesium')) return 'Dark chocolate (70%+), almonds, pumpkin seeds, spinach, black beans, avocado, cashews';
  if (n.includes('b12')) return 'Beef liver, clams, sardines, Atlantic salmon, hard-boiled eggs, Greek yogurt';
  if (n.includes('omega') || n.includes('fish oil')) return 'Atlantic salmon, mackerel, sardines, herring, anchovies, walnuts, chia seeds, flaxseeds';
  if (n.includes('vitamin d')) return 'Sockeye salmon, canned tuna, rainbow trout, UV-exposed portobello mushrooms, fortified whole milk, egg yolks';
  if (n.includes('zinc')) return 'Oysters, beef chuck, pumpkin seeds, chickpeas, cashews, hemp seeds, crab';
  if (n.includes('iron')) return 'Beef liver, grass-fed ground beef, lentils, tofu, pumpkin seeds, dark chocolate (85%+), spinach';
  if (n.includes('vitamin c')) return 'Red bell peppers, guava, kiwi, strawberries, broccoli, papaya, orange juice';
  if (n.includes('calcium')) return 'Plain Greek yogurt, canned sardines with bones, kale, bok choy, fortified oat milk, almonds, white beans';
  if (n.includes('potassium')) return 'Sweet potatoes, avocado, spinach, white beans, bananas, Atlantic salmon, beet greens';
  if (n.includes('selenium')) return 'Brazil nuts (1-2 per day), yellowfin tuna, sardines, hard-boiled eggs, sunflower seeds, chicken breast';
  if (n.includes('vitamin k')) return 'Kale, Swiss chard, spinach, Brussels sprouts, broccoli, natto, parsley';
  if (n.includes('vitamin b6') || n.includes('b6')) return 'Chickpeas, yellowfin tuna, chicken breast, potatoes, bananas, pistachio nuts';
  if (n.includes('folate') || n.includes('folic')) return 'Beef liver, edamame, lentils, asparagus, spinach, avocado, black-eyed peas';
  if (n.includes('iodine')) return 'Seaweed (nori, wakame), cod, plain yogurt, iodized salt, shrimp, eggs';
  if (n.includes('coq10')) return 'Beef heart, herring, chicken liver, rainbow trout, peanuts, sesame seeds, broccoli';
  if (n.includes('collagen')) return 'Bone broth, chicken skin, pork rinds, sardines, egg whites, citrus fruits (for Vitamin C to support collagen synthesis)';
  if (n.includes('probiotic')) return 'Plain Greek yogurt, kefir, kimchi, sauerkraut, miso, tempeh, kombucha';
  if (n.includes('curcumin') || n.includes('turmeric')) return 'Turmeric root, curry powder, golden milk, turmeric tea (pair with black pepper to enhance absorption)';
  if (n.includes('ashwagandha')) return 'Ashwagandha root powder (supplement form — not widely available in common foods)';
  if (n.includes('creatine')) return 'Beef, pork, herring, salmon, tuna, chicken breast (creatine is found almost exclusively in animal muscle tissue)';
  if (n.includes('melatonin')) return 'Tart cherries, walnuts, almonds, oats, bananas, tomatoes, grapes';
  if (n.includes('inositol')) return 'Cantaloupe, citrus fruits, beans, brown rice, corn, sesame seeds, wheat germ';
  return 'Obtain from a varied whole-food diet including lean proteins, leafy greens, legumes, and whole grains';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: infer side effects Ã¢â€â‚¬Ã¢â€â‚¬
function inferSideEffects(name) {
  const n = name.toLowerCase();
  if (n.includes('magnesium')) return 'Loose stools at high doses (>400mg). Glycinate form minimizes this. Upper limit: 350mg supplemental.';
  if (n.includes('iron')) return 'Constipation, nausea, dark stools. Take with food if stomach upset occurs. Do not exceed 45mg/day without medical supervision.';
  if (n.includes('zinc')) return 'Nausea if taken on empty stomach. Long-term high doses (>40mg) may deplete copper. Take with food.';
  if (n.includes('vitamin d')) return 'Toxicity possible above 4000 IU/day long-term. Symptoms: nausea, weakness, frequent urination. Get levels tested before high-dose use.';
  if (n.includes('omega') || n.includes('fish oil')) return 'Fishy aftertaste, mild GI upset. Take with meals. High doses (>3g) may thin blood.';
  if (n.includes('ashwagandha')) return 'May cause drowsiness in some. Avoid in pregnancy. Rare: liver sensitivity at very high doses.';
  if (n.includes('b12')) return 'Very safe Ã¢â‚¬â€ water soluble, excess is excreted. No known toxicity at recommended doses.';
  if (n.includes('coq10')) return 'Generally well tolerated. Mild GI upset possible. May lower blood pressure Ã¢â‚¬â€ monitor if on BP medications.';
  if (n.includes('curcumin')) return 'May cause GI upset at high doses. Avoid high doses in pregnancy or with blood thinners.';
  if (n.includes('berberine')) return 'May cause GI discomfort initially. Can lower blood sugar Ã¢â‚¬â€ monitor if diabetic. Avoid in pregnancy.';
  return 'Generally well tolerated at recommended doses. Discontinue if adverse reactions occur.';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: build meal recommendations Ã¢â€â‚¬Ã¢â€â‚¬
function buildMealRecs(symptoms, goals, conditions, a) {
  const meals = [];
  const fd = (a.feelingDescription || '').toLowerCase();

  if (symptoms.includes('Fatigue') || goals.includes('Increase Energy') || /tired|exhausted/.test(fd)) {
    meals.push({ meal: 'Breakfast', suggestion: 'Spinach and egg omelette with whole grain toast Ã¢â‚¬â€ rich in iron, B12, and complex carbs for sustained energy.' });
    meals.push({ meal: 'Snack', suggestion: 'Handful of pumpkin seeds and a small orange Ã¢â‚¬â€ provides magnesium, zinc, and Vitamin C for iron absorption.' });
  }
  if (symptoms.includes('Poor Sleep') || goals.includes('Improve Sleep')) {
    meals.push({ meal: 'Dinner', suggestion: 'Baked salmon with sweet potato and steamed broccoli Ã¢â‚¬â€ tryptophan, magnesium, and B6 support melatonin production.' });
    meals.push({ meal: 'Evening Snack', suggestion: 'Warm chamomile tea with a small handful of almonds Ã¢â‚¬â€ magnesium and L-theanine promote relaxation.' });
  }
  if (symptoms.includes('Brain Fog') || goals.includes('Enhance Mental Clarity')) {
    meals.push({ meal: 'Breakfast', suggestion: 'Overnight oats with walnuts, blueberries, and chia seeds Ã¢â‚¬â€ omega-3, antioxidants, and slow-release carbs for brain fuel.' });
  }
  if (symptoms.includes('Digestive Issue') || goals.includes('Digestive Health') || /digest|bloat/.test(fd)) {
    meals.push({ meal: 'Lunch', suggestion: 'Greek yogurt with berries and flaxseeds Ã¢â‚¬â€ probiotics, prebiotics, and fiber to support gut microbiome.' });
    meals.push({ meal: 'Dinner', suggestion: 'Lentil soup with garlic and ginger Ã¢â‚¬â€ prebiotic fiber, anti-inflammatory compounds, and plant protein.' });
  }
  if (symptoms.includes('Anxiety/Stress') || /stress|anxious/.test(fd)) {
    meals.push({ meal: 'Lunch', suggestion: 'Avocado and turkey wrap with leafy greens Ã¢â‚¬â€ magnesium, tryptophan, and B vitamins support stress response.' });
  }
  if (conditions.includes('High Blood Pressure')) {
    meals.push({ meal: 'Breakfast', suggestion: 'Oatmeal with banana and low-fat milk Ã¢â‚¬â€ potassium, magnesium, and fiber support healthy blood pressure (DASH diet).' });
  }
  if (conditions.includes('Diabetes')) {
    meals.push({ meal: 'Lunch', suggestion: 'Grilled chicken salad with chickpeas, olive oil, and vinegar dressing Ã¢â‚¬â€ low glycemic, high fiber, supports blood sugar stability.' });
  }
  if (meals.length < 2) {
    meals.push({ meal: 'Breakfast', suggestion: 'Eggs with avocado on whole grain toast Ã¢â‚¬â€ protein, healthy fats, and B vitamins for sustained energy and focus.' });
    meals.push({ meal: 'Lunch', suggestion: 'Salmon or tuna salad with mixed greens, olive oil, and lemon Ã¢â‚¬â€ omega-3, Vitamin D, and antioxidants.' });
    meals.push({ meal: 'Dinner', suggestion: 'Stir-fried vegetables with tofu or chicken over brown rice Ã¢â‚¬â€ balanced macros, fiber, and micronutrients.' });
  }
  return meals.slice(0, 4);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Helper: build daily schedule Ã¢â€â‚¬Ã¢â€â‚¬
function buildDailySchedule(recs) {
  const morning = recs.filter(r => /morning|breakfast|empty stomach|wake/i.test(r.timing)).map(r => r.name);
  const withLunch = recs.filter(r => /lunch|midday|noon|with meal/i.test(r.timing) && !/morning|evening|bed/i.test(r.timing)).map(r => r.name);
  const evening = recs.filter(r => /evening|dinner|night/i.test(r.timing) && !/bed/i.test(r.timing)).map(r => r.name);
  const beforeBed = recs.filter(r => /bed|sleep|before bed/i.test(r.timing)).map(r => r.name);

  // Catch anything not yet scheduled
  const scheduled = new Set([...morning, ...withLunch, ...evening, ...beforeBed]);
  const unscheduled = recs.filter(r => !scheduled.has(r.name)).map(r => r.name);
  if (unscheduled.length) morning.push(...unscheduled);

  const schedule = [];
  if (morning.length) schedule.push({ time: 'Morning (with breakfast)', supplements: morning });
  if (withLunch.length) schedule.push({ time: 'With Lunch', supplements: withLunch });
  if (evening.length) schedule.push({ time: 'Evening (with dinner)', supplements: evening });
  if (beforeBed.length) schedule.push({ time: 'Before Bed', supplements: beforeBed });
  return schedule;
}

module.exports = router;











