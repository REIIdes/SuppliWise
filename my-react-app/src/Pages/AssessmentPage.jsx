import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { saveAssessment, getRecommendations, saveAssessmentResults } from '../api';
import './AssessmentPage.css';

const TOTAL_STEPS = 4;
const SESSION_KEY = 'pending_assessment';

// Age limits — no upper hint shown to the user
const LIMITS = {
  age:    { min: 1,   max: 120 },
  weightKg: { min: 1, max: 500 },
  weightLb: { min: 2, max: 1100 },
  heightCm: { min: 30, max: 300 },
  heightFt: { min: 1, max: 9 },
  heightIn: { min: 0, max: 11 },
};

function clamp(value, min, max) {
  const n = Number(value);
  if (isNaN(n) || value === '') return value;
  if (n < min) return String(min);
  if (n > max) return String(max);
  return String(n);
}

function isSpam(text) {
  if (!text || !text.trim()) return false;
  const t = text.trim();
  if (/^(.)\1{4,}$/.test(t)) return true;
  if (/^[^a-zA-Z0-9]+$/.test(t)) return true;
  return false;
}

// Convert lbs to kg (rounded to 1 decimal)
function lbsToKg(lbs) {
  return Math.round(Number(lbs) * 0.453592 * 10) / 10;
}

// Convert kg to lbs (rounded)
function kgToLbs(kg) {
  return Math.round(Number(kg) * 2.20462);
}

// Convert feet+inches to cm
function ftInToCm(ft, inches) {
  return Math.round((Number(ft) * 30.48) + (Number(inches || 0) * 2.54));
}

// Convert cm to feet and inches
function cmToFtIn(cm) {
  const totalInches = Number(cm) / 2.54;
  const ft = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return { ft, inches };
}

// ── Diet info tooltips ─────────────────────────────────────────────────────
const DIET_INFO = {
  Omnivore:      'Eats both plant and animal foods. No major restrictions — the most common diet type.',
  Vegan:         'Excludes all animal products including dairy, eggs, and honey. Fully plant-based.',
  Keto:          'Very low carbohydrate, high fat diet. Puts the body into ketosis to burn fat for energy.',
  Paleo:         'Based on foods similar to what early humans ate — lean meats, fish, fruits, vegetables, nuts. Avoids processed foods, grains, and dairy.',
  Mediterranean: 'Rich in fruits, vegetables, whole grains, olive oil, and fish. Associated with heart health benefits.',
  Carnivore:     'Consists entirely of animal products — meat, fish, eggs, and some dairy. Eliminates all plant foods.',
  DASH:          'Dietary Approaches to Stop Hypertension. Focuses on fruits, vegetables, whole grains, and low-sodium foods to support healthy blood pressure.',
  Flexitarian:   'Primarily plant-based diet that occasionally includes meat or fish. Flexible approach to vegetarianism.',
  Pescatarian:   'Plant-based diet that includes fish and seafood but excludes other meats.',
};

// Small tooltip component for diet types
function DietTooltip({ diet, openDiet, onToggle }) {
  const visible = openDiet === diet;
  return (
    <span className="diet-tooltip-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="diet-info-btn"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(visible ? null : diet); }}
        aria-label={`Info about ${diet}`}
      >
        ?
      </button>
      {visible && (
        <span className="diet-tooltip-box">
          {DIET_INFO[diet]}
          <button
            type="button"
            className="diet-tooltip-close"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(null); }}
          >
            ✕
          </button>
        </span>
      )}
    </span>
  );
}

// ── Condition info tooltips ──────────────────────────────────────────────
const CONDITION_INFO = {
  'Hypertension (High Blood Pressure)': 'Blood pressure consistently above 130/80 mmHg. The heart works harder than normal to pump blood, which can strain blood vessels and organs over time.',
  'High Cholesterol': 'Elevated levels of LDL ("bad") cholesterol or total cholesterol in the blood, which can increase the risk of plaque buildup in arteries.',
  'Diabetes': 'Type 1: The body produces little to no insulin (autoimmune). Type 2: The body does not use insulin effectively, leading to high blood sugar. Prediabetes: Blood sugar is elevated but not yet diabetic range.',
  'Heart Disease / Cardiovascular Disease': 'A broad term covering conditions affecting the heart and blood vessels, including coronary artery disease, heart failure, and arrhythmia.',
  'Obesity': 'A BMI of 30 or higher, associated with excess body fat that increases risk for diabetes, heart disease, joint problems, and other conditions.',
  'Arthritis': 'Inflammation of one or more joints causing pain and stiffness. Osteoarthritis is wear-and-tear; Rheumatoid arthritis is autoimmune.',
  'Osteoporosis': 'A condition where bones become weak and brittle due to reduced bone density, increasing the risk of fractures especially in the hip, spine, and wrist.',
  'Gout': 'A form of arthritis caused by a buildup of uric acid crystals in joints, most commonly the big toe, causing sudden severe pain and swelling.',
  'Irritable Bowel Syndrome (IBS)': 'A common gut disorder causing recurring abdominal pain, bloating, and changes in bowel habits (diarrhea, constipation, or both) without visible damage to the digestive tract.',
  'Celiac Disease / Gluten Sensitivity': 'Celiac disease: An autoimmune condition where gluten damages the small intestine. Non-celiac gluten sensitivity: Similar symptoms without the autoimmune response.',
  'Asthma': 'A chronic respiratory condition where airways become inflamed and narrowed, causing episodes of wheezing, shortness of breath, chest tightness, and coughing.',
  'Autoimmune Disorders': 'Conditions where the immune system mistakenly attacks the body\'s own tissues. Examples include lupus, rheumatoid arthritis, multiple sclerosis, and psoriasis.',
  'Anxiety Disorder': 'Persistent, excessive worry or fear that interferes with daily activities. Includes generalized anxiety, panic disorder, and social anxiety.',
  'Depression': 'A mood disorder causing persistent sadness, loss of interest, fatigue, and other symptoms that significantly affect daily functioning.',
  'Thyroid Disorders': 'Hypothyroidism: Underactive thyroid — causes fatigue, weight gain, and cold sensitivity. Hyperthyroidism: Overactive thyroid — causes weight loss, rapid heartbeat, and anxiety.',
  'Anemia': 'A deficiency in red blood cells or hemoglobin resulting in reduced oxygen delivery to tissues. Most commonly caused by iron, B12, or folate deficiency.',
  'Chronic Kidney Disease': 'Gradual loss of kidney function over time. Affects the kidneys\' ability to filter waste and regulate minerals, requiring careful management of supplements and diet.',
  'Liver Disease': 'Damage or dysfunction of the liver affecting its ability to process nutrients, filter toxins, and produce proteins. Includes fatty liver, hepatitis, and cirrhosis.',
  'Migraine': 'A neurological condition characterized by recurring moderate to severe headaches, often with nausea, light sensitivity, and visual disturbances.',
  'PCOS': 'Polycystic Ovary Syndrome — a hormonal disorder in people with ovaries causing irregular periods, elevated androgens, and often small cysts on the ovaries. Linked to insulin resistance.',
};

// Reusable condition tooltip component
function ConditionTooltip({ condition, openCondition, onToggle }) {
  const visible = openCondition === condition;
  if (!CONDITION_INFO[condition]) return null;
  return (
    <span className="diet-tooltip-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="diet-info-btn"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(visible ? null : condition); }}
        aria-label={`Info about ${condition}`}
      >
        ?
      </button>
      {visible && (
        <span className="diet-tooltip-box">
          {CONDITION_INFO[condition]}
          <button
            type="button"
            className="diet-tooltip-close"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(null); }}
          >
            ✕
          </button>
        </span>
      )}
    </span>
  );
}
function Step1({ data, onChange, errors }) {
  const age = Number(data.age) || 0;
  const showActivityLevel = age === 0 || age >= 13;

  // Weight unit toggle — default kg
  const weightUnit = data.weightUnit || 'kg';
  // Height unit toggle — default cm
  const heightUnit = data.heightUnit || 'cm';

  const activityOptions = [
    {
      value: 'Sedentary',
      label: 'Sedentary / No Exercise',
      description: 'Little to no physical activity. Mostly sitting or lying down throughout the day — typical of desk jobs with no structured exercise routine.',
    },
    {
      value: 'Light',
      label: 'Light (1–3 days/week)',
      description: 'Light activity 1–3 days per week. Includes casual walking, light stretching, or easy household chores. Not intense enough to cause significant sweating or elevated heart rate.',
    },
    {
      value: 'Moderate',
      label: 'Moderate (3–5 days/week)',
      description: 'Moderate exercise 3–5 days per week. Includes brisk walking, cycling, swimming, or gym workouts at a comfortable pace. Causes noticeable breathing and some sweating.',
    },
    {
      value: 'Very',
      label: 'Very Active (6–7 days/week)',
      description: 'Intense physical activity 6–7 days per week. Includes heavy gym training, competitive sports, running, or physically demanding work. High energy expenditure daily.',
    },
  ];

  // When user switches weight unit, convert the stored value
  const handleWeightUnitChange = (unit) => {
    onChange('weightUnit', unit);
    if (data.weight) {
      if (unit === 'lbs' && weightUnit === 'kg') {
        onChange('weight', String(kgToLbs(data.weight)));
      } else if (unit === 'kg' && weightUnit === 'lbs') {
        onChange('weight', String(lbsToKg(data.weight)));
      }
    }
  };

  // When user switches height unit, convert the stored value
  const handleHeightUnitChange = (unit) => {
    onChange('heightUnit', unit);
    if (unit === 'ft' && heightUnit === 'cm' && data.height) {
      const { ft, inches } = cmToFtIn(data.height);
      onChange('heightFt', String(ft));
      onChange('heightIn', String(inches));
    } else if (unit === 'cm' && heightUnit === 'ft') {
      const ft = Number(data.heightFt) || 0;
      const inches = Number(data.heightIn) || 0;
      if (ft > 0) onChange('height', String(ftInToCm(ft, inches)));
    }
  };

  // When ft/in fields change, update the stored cm value
  const handleFtChange = (val) => {
    onChange('heightFt', val);
    const inches = Number(data.heightIn) || 0;
    if (val) onChange('height', String(ftInToCm(val, inches)));
  };

  const handleInChange = (val) => {
    onChange('heightIn', val);
    const ft = Number(data.heightFt) || 0;
    if (ft > 0) onChange('height', String(ftInToCm(ft, val)));
  };

  return (
    <div className="step-body">
      <h3 className="step-section-title">Basic Information</h3>

      <div className="step-row">
        {/* Age — no upper limit hint shown */}
        <div className={`step-field ${errors.age ? 'field-error' : ''}`}>
          <label>Age <span className="required-star">*</span></label>
          <input
            type="number"
            placeholder="Enter your age"
            value={data.age}
            min={1}
            onChange={(e) => onChange('age', e.target.value)}
            onBlur={(e) => onChange('age', clamp(e.target.value, 1, 120))}
          />
          {errors.age && <span className="field-error-msg">{errors.age}</span>}
        </div>

        {/* Gender — pill button style */}
        <div className={`step-field ${errors.gender ? 'field-error' : ''}`}>
          <label>Gender <span className="required-star">*</span></label>
          <div className="gender-pill-group">
            {['Male', 'Female', 'Prefer not to say'].map((g) => (
              <button
                key={g}
                type="button"
                className={`gender-pill ${data.gender === g ? 'gender-pill-active' : ''}`}
                onClick={() => {
                  onChange('gender', g);
                  if (g !== 'Female') {
                    onChange('isPregnant', '');
                    onChange('isBreastfeeding', '');
                  }
                }}
              >
                {g}
              </button>
            ))}
          </div>
          {errors.gender && <span className="field-error-msg">{errors.gender}</span>}
        </div>
      </div>

      {/* Weight and Height side by side */}
      <div className="step-row">
        {/* Weight with unit toggle */}
        <div className={`step-field ${errors.weight ? 'field-error' : ''}`}>
          <label>
            Weight <span className="required-star">*</span>
            <span className="unit-toggle-inline">
              {['kg', 'lbs'].map(u => (
                <button
                  key={u}
                  type="button"
                  className={`unit-btn ${weightUnit === u ? 'unit-btn-active' : ''}`}
                  onClick={() => handleWeightUnitChange(u)}
                >
                  {u}
                </button>
              ))}
            </span>
          </label>
          <input
            type="number"
            placeholder={weightUnit === 'kg' ? 'e.g. 70' : 'e.g. 154'}
            value={data.weight}
            min={1}
            onChange={(e) => onChange('weight', e.target.value)}
            onBlur={(e) => {
              const lim = weightUnit === 'kg' ? LIMITS.weightKg : LIMITS.weightLb;
              onChange('weight', clamp(e.target.value, lim.min, lim.max));
            }}
          />
          {errors.weight && <span className="field-error-msg">{errors.weight}</span>}
        </div>

        {/* Height with unit toggle */}
        <div className={`step-field ${errors.height ? 'field-error' : ''}`}>
          <label>
            Height <span className="required-star">*</span>
            <span className="unit-toggle-inline">
              {['cm', 'ft'].map(u => (
                <button
                  key={u}
                  type="button"
                  className={`unit-btn ${heightUnit === u ? 'unit-btn-active' : ''}`}
                  onClick={() => handleHeightUnitChange(u)}
                >
                  {u === 'ft' ? 'ft / in' : 'cm'}
                </button>
              ))}
            </span>
          </label>
          {heightUnit === 'cm' ? (
            <input
              type="number"
              placeholder="e.g. 170"
              value={data.height}
              min={30}
              onChange={(e) => onChange('height', e.target.value)}
              onBlur={(e) => onChange('height', clamp(e.target.value, 30, 300))}
            />
          ) : (
            <div className="ft-in-row">
              <input
                type="number"
                placeholder="ft"
                value={data.heightFt || ''}
                min={1} max={9}
                onChange={(e) => handleFtChange(e.target.value)}
                onBlur={(e) => handleFtChange(clamp(e.target.value, 1, 9))}
              />
              <span className="ft-in-sep">ft</span>
              <input
                type="number"
                placeholder="in"
                value={data.heightIn || ''}
                min={0} max={11}
                onChange={(e) => handleInChange(e.target.value)}
                onBlur={(e) => handleInChange(clamp(e.target.value, 0, 11))}
              />
              <span className="ft-in-sep">in</span>
            </div>
          )}
          {errors.height && <span className="field-error-msg">{errors.height}</span>}
        </div>
      </div>

      {showActivityLevel && (
        <div className="step-field">
          <label>Physical Activity Level</label>
          <div className="checkbox-group">
            {activityOptions.map(({ value, label, description }) => (
              <div key={value} className="activity-option-wrap">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="activityLevel"
                    value={value}
                    checked={data.activityLevel === value}
                    onChange={() => onChange('activityLevel', value)}
                  />
                  {label}
                </label>
                {data.activityLevel === value && (
                  <p className="activity-desc">{description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {age > 0 && age < 13 && (
        <div className="step-field">
          <div className="age-notice">
            👶 Activity level is not applicable for children under 13. Physical activity guidance will be tailored to their age group.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 2: Diet & Health Goals ────────────────────────────────────────────
function Step2({ data, onChange }) {
  const age = Number(data.age) || 0;
  const isChild = age > 0 && age < 13;
  const [openDiet, setOpenDiet] = useState(null);

  // Close tooltip when clicking anywhere outside it
  useEffect(() => {
    if (!openDiet) return;
    const handleClick = () => setOpenDiet(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openDiet]);

  // 6 diet types for a balanced grid
  const diets = ['Omnivore', 'Vegan', 'Keto', 'Paleo', 'Mediterranean', 'Carnivore', 'DASH', 'Flexitarian', 'Pescatarian'];

  // Health goals with descriptions — grouped by General, Fitness (Physical/Mental), Wellness
  const adultGoals = [
    // General
    { label: 'Increase Energy',       group: 'General',           subgroup: null, description: 'Reduce fatigue and support sustained energy levels throughout the day.' },
    { label: 'Improve Sleep',         group: 'General',           subgroup: null, description: 'Support healthy sleep onset, quality, and duration for better rest.' },
    { label: 'Boost Immunity',        group: 'General',           subgroup: null, description: 'Strengthen the immune system to help the body resist illness and recover faster.' },
    { label: 'Support Heart Health',  group: 'General',           subgroup: null, description: 'Promote healthy cardiovascular function, circulation, and cholesterol balance.' },
    { label: 'Digestive Health',      group: 'General',           subgroup: null, description: 'Improve gut health, digestion, bloating, and regularity.' },
    // Fitness - Physical
    { label: 'Muscle Gain',           group: 'Fitness',           subgroup: 'Physical', description: 'Support muscle growth, protein synthesis, and strength development.' },
    { label: 'Fat Loss',              group: 'Fitness',           subgroup: 'Physical', description: 'Aid in body fat reduction while preserving lean muscle mass.' },
    { label: 'Improve Strength',      group: 'Fitness',           subgroup: 'Physical', description: 'Enhance physical power, muscular endurance, and workout performance.' },
    { label: 'Improve Endurance',     group: 'Fitness',           subgroup: 'Physical', description: 'Build stamina and aerobic capacity for sustained physical activity.' },
    // Fitness - Mental
    { label: 'Mental Focus',          group: 'Fitness',           subgroup: 'Mental', description: 'Sharpen concentration, alertness, and cognitive performance during tasks.' },
    { label: 'Stress Reduction',      group: 'Fitness',           subgroup: 'Mental', description: 'Lower cortisol levels and support a calm, balanced stress response.' },
    // Wellness
    { label: 'Skin & Hair Health',    group: 'Wellness',          subgroup: null, description: 'Nourish skin hydration, elasticity, and hair strength from within.' },
    { label: 'Bone & Joint Health',   group: 'Wellness',          subgroup: null, description: 'Support bone density, joint flexibility, and reduce stiffness or discomfort.' },
    { label: 'Eye & Vision Health',   group: 'Wellness',          subgroup: null, description: 'Protect eyesight and support visual acuity, especially with screen exposure.' },
    { label: 'Brain & Mental Health', group: 'Wellness',          subgroup: null, description: 'Support cognitive function, mood stability, and overall mental well-being.' },
  ];

  const childGoals = [
    'Boost Immunity', 'Increase Energy', 'Improve Sleep',
    'Digestive Health', 'Bone & Joint Health',
  ];

  const goals = isChild ? childGoals.map(l => ({ label: l, group: '', subgroup: null, description: '' })) : adultGoals;

  // Group adult goals by category for display
  const groups = isChild ? [''] : ['General', 'Fitness', 'Wellness'];

  const toggleGoal = (goal) => {
    const current = data.healthGoals || [];
    onChange('healthGoals', current.includes(goal)
      ? current.filter((g) => g !== goal)
      : [...current, goal]);
  };

  return (
    <div className="step-body">
      <h3 className="step-section-title">Diet &amp; Health Goals</h3>

      {/* Diet type — 6 options in a 3-col grid with info tooltips */}
      <div className="step-field">
        <label>Diet Type</label>
        <div className="checkbox-grid-3">
          {diets.map((d) => (
            <label key={d} className="checkbox-label diet-label">
              <input
                type="radio"
                name="dietType"
                value={d}
                checked={data.dietType === d}
                onChange={() => onChange('dietType', d)}
              />
              {d}
              <DietTooltip diet={d} openDiet={openDiet} onToggle={setOpenDiet} />
            </label>
          ))}
        </div>
      </div>

      {/* Health goals grouped by category */}
      <div className="step-field" style={{ marginTop: '24px' }}>
        <label>Health Goals <span className="field-hint">(select all that apply)</span></label>
        {isChild ? (
          <div className="checkbox-grid-2">
            {goals.map(({ label }) => (
              <label key={label} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={(data.healthGoals || []).includes(label)}
                  onChange={() => toggleGoal(label)}
                />
                {label}
              </label>
            ))}
          </div>
        ) : (
          groups.map((group) => {
            const groupGoals = adultGoals.filter(g => g.group === group);
            // Check if this group has subgroups
            const subgroups = [...new Set(groupGoals.map(g => g.subgroup).filter(Boolean))];
            const hasSubgroups = subgroups.length > 0;

            return (
              <div key={group} className="goal-group">
                <p className="goal-group-label">{group}</p>
                {hasSubgroups ? (
                  subgroups.map(sub => (
                    <div key={sub} className="goal-subgroup">
                      <p className="goal-subgroup-label">{sub}</p>
                      <div className="checkbox-grid-2">
                        {groupGoals.filter(g => g.subgroup === sub).map(({ label, description }) => {
                          const checked = (data.healthGoals || []).includes(label);
                          return (
                            <div key={label} className="goal-option-wrap">
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleGoal(label)}
                                />
                                {label}
                              </label>
                              {checked && description && (
                                <p className="goal-desc">{description}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="checkbox-grid-2">
                    {groupGoals.filter(g => !g.subgroup).map(({ label, description }) => {
                      const checked = (data.healthGoals || []).includes(label);
                      return (
                        <div key={label} className="goal-option-wrap">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleGoal(label)}
                            />
                            {label}
                          </label>
                          {checked && description && (
                            <p className="goal-desc">{description}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Shared symptom/severity constants (used by Step3Combined) ─────────────

// General symptoms shown when user selects None for medical conditions
const GENERAL_SYMPTOMS = [
  'Fatigue',
  'Frequent Headaches',
  'Brain Fog',
  'Anxiety / Stress',
  'Difficulty Sleeping',
  'Low Energy',
  'Digestive Discomfort',
  'Muscle Weakness',
  'Hair Thinning',
  'Dry Skin',
  'Low Mood',
  'Frequent Colds / Low Immunity',
  'Joint Stiffness',
  'Low Appetite',
  'Low Libido',
];

// Per-symptom severity descriptions — shown when a severity button is selected
const SEVERITY_DESCRIPTIONS = {
  Fatigue: {
    Mild:     'Slightly tired by end of day but can manage daily tasks.',
    Moderate: 'Noticeable tiredness that slows you down during the day.',
    Severe:   'Exhausted most of the time, hard to get out of bed or function.',
  },
  'Shortness of Breath': {
    Mild:     'Occasional breathlessness during physical activity, resolves quickly with rest.',
    Moderate: 'Breathlessness with minimal exertion such as walking or climbing stairs.',
    Severe:   'Difficulty breathing even at rest, significantly limits daily activities.',
  },
  'Chest Tightness': {
    Mild:     'Occasional mild pressure or squeezing sensation in the chest.',
    Moderate: 'Frequent chest tightness that is distracting and affects concentration.',
    Severe:   'Persistent or intense chest tightness — seek immediate medical attention.',
  },
  'Rapid or Irregular Heartbeat': {
    Mild:     'Occasional brief episodes of faster or skipped heartbeats.',
    Moderate: 'Frequent palpitations that cause concern or mild dizziness.',
    Severe:   'Persistent racing or irregular heartbeat with dizziness or chest pain.',
  },
  'Dizziness / Lightheadedness': {
    Mild:     'Brief lightheadedness when standing up quickly.',
    Moderate: 'Frequent dizziness that affects balance or causes concern.',
    Severe:   'Severe dizziness causing loss of balance or near-fainting episodes.',
  },
  'Frequent Headaches': {
    Mild:     'Occasional mild headaches, usually relieved by rest or water.',
    Moderate: 'Headaches several times a week that affect concentration.',
    Severe:   'Daily or near-daily headaches that are debilitating.',
  },
  'Excessive Thirst': {
    Mild:     'Slightly more thirsty than usual despite normal fluid intake.',
    Moderate: 'Persistent thirst throughout the day even after drinking regularly.',
    Severe:   'Unrelenting thirst that cannot be satisfied, accompanied by dry mouth.',
  },
  'Frequent Urination': {
    Mild:     'Slightly more trips to the bathroom than usual.',
    Moderate: 'Urinating 8 or more times a day, disrupting daily routine.',
    Severe:   'Very frequent urination including multiple times at night, significantly disruptive.',
  },
  'Blurred Vision': {
    Mild:     'Occasional blurring that resolves on its own.',
    Moderate: 'Frequent blurring that makes reading or screen use difficult.',
    Severe:   'Persistent blurred vision significantly affecting daily activities.',
  },
  'Unexplained Weight Gain': {
    Mild:     'Slight weight gain (1-2 kg) without changes in diet or exercise.',
    Moderate: 'Noticeable weight gain (3-5 kg) despite maintaining usual habits.',
    Severe:   'Significant unexplained weight gain causing physical discomfort or concern.',
  },
  'Unexplained Weight Loss': {
    Mild:     'Slight weight loss (1-2 kg) without intentional dietary changes.',
    Moderate: 'Noticeable weight loss (3-5 kg) without trying.',
    Severe:   'Significant unintentional weight loss raising serious health concerns.',
  },
  'Joint Pain': {
    Mild:     'Mild stiffness or aching, especially in the morning.',
    Moderate: 'Regular joint pain that limits some physical activities.',
    Severe:   'Constant joint pain that makes movement difficult.',
  },
  'Joint Swelling': {
    Mild:     'Slight puffiness around a joint, minimal pain.',
    Moderate: 'Visible swelling with tenderness that limits movement.',
    Severe:   'Significant swelling causing warmth, redness, and inability to use the joint.',
  },
  'Morning Stiffness': {
    Mild:     'Brief stiffness in the morning lasting less than 30 minutes.',
    Moderate: 'Stiffness lasting 30 minutes to an hour, affecting morning routine.',
    Severe:   'Prolonged stiffness lasting over an hour, making it difficult to start the day.',
  },
  'Muscle Weakness': {
    Mild:     'Muscles tire a little faster than expected during activity.',
    Moderate: 'Noticeable weakness when lifting or climbing stairs.',
    Severe:   'Difficulty performing basic tasks like carrying groceries or standing long.',
  },
  'Back / Bone Pain': {
    Mild:     'Occasional mild aching in the back or bones, manageable with rest.',
    Moderate: 'Frequent pain that interferes with daily tasks or sleep.',
    Severe:   'Persistent severe pain limiting movement and requiring pain management.',
  },
  'Bloating': {
    Mild:     'Occasional bloating after certain foods.',
    Moderate: 'Bloating most days, feels uncomfortable after meals.',
    Severe:   'Severe, painful bloating that makes it hard to eat normally.',
  },
  'Digestive Issue': {
    Mild:     'Occasional discomfort or bloating after meals.',
    Moderate: 'Frequent stomach pain, bloating, or irregular bowel movements.',
    Severe:   'Daily digestive pain that disrupts eating and daily activities.',
  },
  Nausea: {
    Mild:     'Mild queasiness that passes quickly without vomiting.',
    Moderate: 'Frequent nausea that affects appetite and daily comfort.',
    Severe:   'Persistent nausea with vomiting that prevents normal eating.',
  },
  'Abdominal Pain / Cramps': {
    Mild:     'Occasional mild cramping, usually relieved by rest or heat.',
    Moderate: 'Frequent cramping that disrupts daily activities.',
    Severe:   'Intense, persistent abdominal pain requiring medical attention.',
  },
  'Wheezing / Breathing Difficulty': {
    Mild:     'Occasional mild wheeze or tightness, especially during exercise.',
    Moderate: 'Frequent wheezing that requires use of a reliever inhaler.',
    Severe:   'Persistent breathing difficulty at rest, significantly limiting activity.',
  },
  'Frequent Colds': {
    Mild:     'Getting sick once or twice a year, recovers quickly.',
    Moderate: 'Gets sick 3-4 times a year, takes longer to recover.',
    Severe:   'Constantly catching colds, rarely feels fully well.',
  },
  'Skin Rashes / Flare-ups': {
    Mild:     'Occasional mild redness or rash that resolves quickly.',
    Moderate: 'Recurring rashes causing itching or discomfort.',
    Severe:   'Persistent widespread rashes causing significant pain or irritation.',
  },
  'Acne / Skin Issues': {
    Mild:     'Occasional pimples or minor breakouts.',
    Moderate: 'Regular breakouts that are hard to control.',
    Severe:   'Persistent, painful acne covering large areas of the face or body.',
  },
  'Dry Skin': {
    Mild:     'Skin feels slightly dry or tight, especially after washing.',
    Moderate: 'Persistent dryness with flaking or itching in some areas.',
    Severe:   'Severely dry, cracked, or irritated skin that causes discomfort.',
  },
  'Persistent Sadness / Low Mood': {
    Mild:     'Occasional low mood or sadness that passes with time.',
    Moderate: 'Frequent low mood that affects motivation and daily enjoyment.',
    Severe:   'Persistent deep sadness that significantly impairs daily functioning.',
  },
  'Panic Attacks': {
    Mild:     'Rare episodes of sudden anxiety with mild physical symptoms.',
    Moderate: 'Occasional panic attacks causing significant distress and avoidance.',
    Severe:   'Frequent, debilitating panic attacks disrupting daily life.',
  },
  'Anxiety / Excessive Worry': {
    Mild:     'Occasional worry that is manageable and short-lived.',
    Moderate: 'Frequent worry or tension that affects sleep or focus.',
    Severe:   'Persistent anxiety that interferes with daily life and relationships.',
  },
  'Sleep Disturbances': {
    Mild:     'Occasional trouble falling or staying asleep.',
    Moderate: 'Frequent sleep disruptions leaving you feeling tired most days.',
    Severe:   'Chronic insomnia significantly affecting energy, mood, and function.',
  },
  'Loss of Interest': {
    Mild:     'Reduced interest in hobbies or activities you usually enjoy.',
    Moderate: 'Noticeable withdrawal from social activities and previous interests.',
    Severe:   'Complete loss of interest in nearly all activities, including basic self-care.',
  },
  'Brain Fog': {
    Mild:     'Occasional difficulty concentrating or mild forgetfulness.',
    Moderate: 'Regularly struggles to focus, forgets things mid-task.',
    Severe:   'Often forgetful, cannot concentrate, feels mentally cloudy most of the day.',
  },
  'Cold Sensitivity': {
    Mild:     'Feeling slightly colder than others in the same environment.',
    Moderate: 'Frequently cold even in warm conditions, needing extra layers.',
    Severe:   'Extreme cold sensitivity significantly affecting comfort and daily activities.',
  },
  'Hair Loss': {
    Mild:     'Slightly more hair than usual in the shower or brush.',
    Moderate: 'Noticeable thinning or patches of hair loss.',
    Severe:   'Significant hair loss visible to others, affecting confidence.',
  },
  'Swollen Neck / Goiter': {
    Mild:     'Slight visible swelling at the base of the throat, no discomfort.',
    Moderate: 'Noticeable swelling causing mild pressure or difficulty swallowing.',
    Severe:   'Large visible goiter causing pain, swallowing difficulty, or breathing issues.',
  },
  'Pale Skin / Pallor': {
    Mild:     'Slightly paler skin tone than usual, especially around the face.',
    Moderate: 'Noticeably pale skin with reduced color in lips and gums.',
    Severe:   'Extreme pallor with fatigue and breathlessness indicating significant anemia.',
  },
  'Numbness / Tingling': {
    Mild:     'Occasional pins-and-needles in hands or feet.',
    Moderate: 'Regular numbness or tingling that comes and goes.',
    Severe:   'Persistent numbness or tingling that affects grip or movement.',
  },
  'Slow Recovery': {
    Mild:     'Takes a day or two longer than expected to recover after exercise.',
    Moderate: 'Muscles stay sore for several days, feels run-down after activity.',
    Severe:   'Barely recovers between workouts or illnesses, always feeling depleted.',
  },
  'Swelling (Edema)': {
    Mild:     'Slight puffiness in the ankles or feet by end of day.',
    Moderate: 'Noticeable swelling in legs or feet that persists through the day.',
    Severe:   'Significant swelling causing discomfort, skin tightness, or difficulty walking.',
  },
  'Jaundice / Yellow Skin': {
    Mild:     'Slight yellowing of the whites of the eyes.',
    Moderate: 'Visible yellowing of skin and eyes with mild fatigue.',
    Severe:   'Pronounced yellow discoloration with dark urine and significant fatigue.',
  },
  'Light / Sound Sensitivity': {
    Mild:     'Mild discomfort in bright light or loud environments.',
    Moderate: 'Significant sensitivity requiring sunglasses or avoiding loud spaces.',
    Severe:   'Extreme sensitivity making it impossible to function in normal environments.',
  },
  'Visual Aura': {
    Mild:     'Brief flashing lights or blind spots lasting a few minutes before a headache.',
    Moderate: 'Visual disturbances lasting 20-30 minutes causing concern.',
    Severe:   'Prolonged or complex aura significantly impairing vision before or during a migraine.',
  },
  'Low Appetite': {
    Mild:     'Slightly less hungry than usual, skips a meal occasionally.',
    Moderate: 'Regularly not hungry, eating less than needed.',
    Severe:   'Rarely feels hungry, significant reduction in food intake.',
  },
  'Low Libido': {
    Mild:     'Slightly reduced interest in intimacy compared to before.',
    Moderate: 'Noticeably lower drive that affects relationships.',
    Severe:   'Little to no interest in intimacy, causing personal concern.',
  },
  'Irregular Periods': {
    Mild:     'Cycle is slightly irregular (a few days off) occasionally.',
    Moderate: 'Periods are frequently late, early, or skipped.',
    Severe:   'Very unpredictable cycle or periods missing for months.',
  },
  'Hormonal Acne': {
    Mild:     'Occasional breakouts around the chin or jawline before periods.',
    Moderate: 'Recurring hormonal breakouts that are difficult to manage.',
    Severe:   'Persistent cystic acne on chin, jaw, or cheeks significantly affecting confidence.',
  },
  'Excessive Hair Growth': {
    Mild:     'Slightly more facial or body hair than usual.',
    Moderate: 'Noticeable unwanted hair growth on face, chest, or abdomen.',
    Severe:   'Significant excess hair growth causing significant distress.',
  },
  'Pelvic Pain': {
    Mild:     'Occasional mild pelvic discomfort, especially during periods.',
    Moderate: 'Frequent pelvic pain that interferes with daily activities.',
    Severe:   'Persistent, severe pelvic pain significantly affecting quality of life.',
  },

  'Anxiety / Stress': {
    Mild:     'Feels stressed occasionally but can manage it.',
    Moderate: 'Frequent worry or tension that affects sleep or focus.',
    Severe:   'Persistent anxiety that interferes with daily life and relationships.',
  },
  'Difficulty Sleeping': {
    Mild:     'Occasional trouble falling asleep or waking up once during the night.',
    Moderate: 'Frequently takes a long time to fall asleep or wakes up multiple times.',
    Severe:   'Chronic inability to sleep, leaving you exhausted most days.',
  },
  'Low Energy': {
    Mild:     'Slightly less energetic than usual by midday.',
    Moderate: 'Regularly feels drained before the day is done.',
    Severe:   'Constantly exhausted with little energy for daily tasks.',
  },
  'Digestive Discomfort': {
    Mild:     'Occasional mild bloating or stomach discomfort.',
    Moderate: 'Frequent digestive upset affecting eating habits.',
    Severe:   'Daily digestive pain or discomfort significantly disrupting normal activities.',
  },
  'Hair Thinning': {
    Mild:     'Slightly more hair than usual in the shower or brush.',
    Moderate: 'Noticeable thinning or reduced hair density.',
    Severe:   'Significant hair thinning visible to others.',
  },
  'Frequent Colds / Low Immunity': {
    Mild:     'Getting sick once or twice a year with quick recovery.',
    Moderate: 'Gets sick 3–4 times a year, takes longer to recover.',
    Severe:   'Constantly catching illnesses, rarely feels fully well.',
  },
  'Joint Stiffness': {
    Mild:     'Brief stiffness in the morning, resolves within 30 minutes.',
    Moderate: 'Stiffness lasting over 30 minutes affecting morning routine.',
    Severe:   'Prolonged stiffness throughout the day limiting movement.',
  },
};

// Symptom list — removed "Mood Swings" (psychological) and "Low Libido"
// Gender-specific symptoms are filtered in the component
const ALL_SYMPTOMS = [
  // ── Cardiovascular & Metabolic ──────────────────────────────────────────
  { name: 'Fatigue',                       genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Hypertension (High Blood Pressure)', 'High Cholesterol', 'Diabetes', 'Heart Disease / Cardiovascular Disease', 'Obesity', 'Anemia', 'Thyroid Disorders', 'Chronic Kidney Disease', 'Liver Disease', 'Anxiety Disorder', 'Depression'] },
  { name: 'Shortness of Breath',           genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Heart Disease / Cardiovascular Disease', 'Asthma', 'Obesity'] },
  { name: 'Chest Tightness',               genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Heart Disease / Cardiovascular Disease', 'Asthma', 'Hypertension (High Blood Pressure)'] },
  { name: 'Rapid or Irregular Heartbeat',  genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Heart Disease / Cardiovascular Disease', 'Hypertension (High Blood Pressure)', 'Anxiety Disorder', 'Thyroid Disorders'] },
  { name: 'Dizziness / Lightheadedness',   genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Hypertension (High Blood Pressure)', 'Anemia', 'Diabetes', 'Heart Disease / Cardiovascular Disease'] },
  { name: 'Frequent Headaches',            genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Hypertension (High Blood Pressure)', 'Migraine', 'Anxiety Disorder', 'Depression'] },
  { name: 'Excessive Thirst',              genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Diabetes'] },
  { name: 'Frequent Urination',            genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Diabetes', 'Chronic Kidney Disease'] },
  { name: 'Blurred Vision',               genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Diabetes', 'Hypertension (High Blood Pressure)'] },
  { name: 'Unexplained Weight Gain',       genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Thyroid Disorders', 'Obesity', 'Diabetes'] },
  { name: 'Unexplained Weight Loss',       genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Thyroid Disorders', 'Diabetes'] },

  // ── Bone & Joint ─────────────────────────────────────────────────────────
  { name: 'Joint Pain',                    genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Arthritis', 'Gout', 'Osteoporosis', 'Autoimmune Disorders'] },
  { name: 'Joint Swelling',               genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Arthritis', 'Gout'] },
  { name: 'Morning Stiffness',             genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Arthritis', 'Autoimmune Disorders'] },
  { name: 'Muscle Weakness',              genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Arthritis', 'Autoimmune Disorders', 'Thyroid Disorders', 'Anemia', 'Chronic Kidney Disease'] },
  { name: 'Back / Bone Pain',             genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Osteoporosis', 'Arthritis'] },

  // ── Digestive ─────────────────────────────────────────────────────────────
  { name: 'Bloating',                      genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Irritable Bowel Syndrome (IBS)', 'Celiac Disease / Gluten Sensitivity'] },
  { name: 'Digestive Issue',               genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Irritable Bowel Syndrome (IBS)', 'Celiac Disease / Gluten Sensitivity', 'Liver Disease'] },
  { name: 'Nausea',                        genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Irritable Bowel Syndrome (IBS)', 'Migraine', 'Chronic Kidney Disease', 'Liver Disease'] },
  { name: 'Abdominal Pain / Cramps',       genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Irritable Bowel Syndrome (IBS)', 'Celiac Disease / Gluten Sensitivity'] },
  { name: 'Low Appetite',                  genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Liver Disease', 'Chronic Kidney Disease', 'Depression', 'Irritable Bowel Syndrome (IBS)'] },

  // ── Respiratory & Immune ─────────────────────────────────────────────────
  { name: 'Wheezing / Breathing Difficulty', genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Asthma'] },
  { name: 'Frequent Colds',               genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Autoimmune Disorders', 'Asthma'] },
  { name: 'Skin Rashes / Flare-ups',      genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Autoimmune Disorders', 'Celiac Disease / Gluten Sensitivity'] },
  { name: 'Acne / Skin Issues',            genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Autoimmune Disorders'] },
  { name: 'Dry Skin',                      genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Thyroid Disorders', 'Autoimmune Disorders', 'Diabetes'] },

  // ── Mental Health ─────────────────────────────────────────────────────────
  { name: 'Persistent Sadness / Low Mood', genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Depression', 'Thyroid Disorders'] },
  { name: 'Panic Attacks',                 genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Anxiety Disorder'] },
  { name: 'Anxiety / Excessive Worry',     genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Anxiety Disorder', 'Thyroid Disorders'] },
  { name: 'Sleep Disturbances',            genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Anxiety Disorder', 'Depression', 'Thyroid Disorders'] },
  { name: 'Loss of Interest',              genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Depression'] },
  { name: 'Brain Fog',                     genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Depression', 'Anxiety Disorder', 'Thyroid Disorders', 'Anemia', 'Chronic Kidney Disease', 'Celiac Disease / Gluten Sensitivity'] },

  // ── Thyroid / Anemia / Kidney / Liver ────────────────────────────────────
  { name: 'Cold Sensitivity',              genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Thyroid Disorders', 'Anemia'] },
  { name: 'Hair Loss',                     genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Thyroid Disorders', 'Anemia', 'Autoimmune Disorders'] },
  { name: 'Swollen Neck / Goiter',         genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Thyroid Disorders'] },
  { name: 'Pale Skin / Pallor',            genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Anemia'] },
  { name: 'Numbness / Tingling',           genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Diabetes', 'Anemia', 'Chronic Kidney Disease'] },
  { name: 'Slow Recovery',                 genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Anemia', 'Autoimmune Disorders', 'Diabetes', 'Heart Disease / Cardiovascular Disease'] },
  { name: 'Swelling (Edema)',              genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Chronic Kidney Disease', 'Heart Disease / Cardiovascular Disease', 'Liver Disease'] },
  { name: 'Jaundice / Yellow Skin',        genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Liver Disease'] },

  // ── Migraine ─────────────────────────────────────────────────────────────
  { name: 'Light / Sound Sensitivity',     genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Migraine'] },
  { name: 'Visual Aura',                   genders: ['Male', 'Female', 'Prefer not to say'], conditions: ['Migraine'] },

  // ── Female-specific ──────────────────────────────────────────────────────
  { name: 'Irregular Periods',             genders: ['Female'],                              conditions: ['PCOS'] },
  { name: 'Hormonal Acne',                 genders: ['Female'],                              conditions: ['PCOS'] },
  { name: 'Excessive Hair Growth',         genders: ['Female'],                              conditions: ['PCOS'] },
  { name: 'Pelvic Pain',                   genders: ['Female'],                              conditions: ['PCOS'] },

  // ── Male / Neutral ────────────────────────────────────────────────────────
  { name: 'Low Libido',                    genders: ['Male', 'Prefer not to say'],           conditions: ['Diabetes', 'Hypertension (High Blood Pressure)', 'Depression', 'Thyroid Disorders'] },
];

const SEVERITY_OPTIONS = ['Mild', 'Moderate', 'Severe'];

// Sleep quality mapped to hour ranges
const SLEEP_OPTIONS = [
  { value: 'Very Poor',  label: 'Very Poor  (less than 4 hrs)' },
  { value: 'Poor',       label: 'Poor  (4–5 hrs)' },
  { value: 'Average',    label: 'Average  (6–7 hrs)' },
  { value: 'Good',       label: 'Good  (7–8 hrs)' },
  { value: 'Excellent',  label: 'Excellent  (8+ hrs)' },
];

// Water intake in glasses (8 oz / 240 ml each)
const WATER_OPTIONS = [
  { value: 'Less than 4 glasses',  label: 'Less than 4 glasses a day' },
  { value: '4–6 glasses',          label: '4–6 glasses a day' },
  { value: '7–8 glasses',          label: '7–8 glasses a day' },
  { value: '9+ glasses',           label: '9 or more glasses a day' },
];

function Step3Combined({ data, onChange, errors = {}, symptomRowRefs = { current: {} } }) {
  // ── Medical conditions ──
  const conditionGroups = [
    {
      group: 'Cardiovascular & Metabolic',
      items: ['Hypertension (High Blood Pressure)', 'High Cholesterol', 'Diabetes', 'Heart Disease / Cardiovascular Disease', 'Obesity'],
    },
    {
      group: 'Bone & Joint',
      items: ['Arthritis', 'Osteoporosis', 'Gout'],
    },
    {
      group: 'Digestive',
      items: ['Irritable Bowel Syndrome (IBS)', 'Celiac Disease / Gluten Sensitivity'],
    },
    {
      group: 'Respiratory & Immune',
      items: ['Asthma', 'Autoimmune Disorders'],
    },
    {
      group: 'Mental Health',
      items: ['Anxiety Disorder', 'Depression'],
    },
    {
      group: 'Other',
      items: [
        'Thyroid Disorders', 'Anemia', 'Chronic Kidney Disease',
        'Liver Disease', 'Migraine',
        ...(data.gender === 'Female' || data.gender === 'Prefer not to say' ? ['PCOS'] : []),
      ],
    },
  ];

  const [openCondition, setOpenCondition] = useState(null);

  // Close condition tooltip on outside click
  useEffect(() => {
    if (!openCondition) return;
    const handler = () => setOpenCondition(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openCondition]);

  const toggleCondition = (c) => {
    const current = data.medicalConditions || [];
    if (c === 'None') {
      onChange('medicalConditions', current.includes('None') ? [] : ['None']);
      // Clear all symptoms and severities when None is toggled
      onChange('symptoms', []);
      onChange('symptomSeverity', {});
      onChange('noSymptomsForConditions', []);
      return;
    }
    const filtered = current.filter((x) => x !== 'None');
    const isRemoving = filtered.includes(c);
    onChange('medicalConditions', isRemoving
      ? filtered.filter((x) => x !== c)
      : [...filtered, c]);

    if (isRemoving) {
      // Clear all symptoms and severities keyed to this condition
      const updatedSymptoms = (data.symptoms || []).filter(s => !s.startsWith(c + '::'));
      const updatedSeverity = Object.fromEntries(
        Object.entries(data.symptomSeverity || {}).filter(([key]) => !key.startsWith(c + '::'))
      );
      const updatedNoSymptoms = (data.noSymptomsForConditions || []).filter(x => x !== c);
      onChange('symptoms', updatedSymptoms);
      onChange('symptomSeverity', updatedSeverity);
      onChange('noSymptomsForConditions', updatedNoSymptoms);
    }
  };

  // If gender switches to Male, remove PCOS from selected conditions
  useEffect(() => {
    if (data.gender === 'Male' && (data.medicalConditions || []).includes('PCOS')) {
      onChange('medicalConditions', data.medicalConditions.filter(c => c !== 'PCOS'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.gender]);

  const showPregnancy = data.gender === 'Female' || data.gender === 'Prefer not to say';

  // ── Symptoms ──
  const selectedSymptoms = data.symptoms || [];
  const symptomSeverity = data.symptomSeverity || {};
  const gender = data.gender || '';
  const isPregnantOrBreastfeeding = data.isPregnant === 'Yes' || data.isBreastfeeding === 'Yes';
  const visibleSymptoms = ALL_SYMPTOMS.filter(s => {
    // Gender filter
    if (s.genders.length > 0 && !s.genders.includes(gender) && gender !== '') return false;
    if (s.name === 'Low Libido' && isPregnantOrBreastfeeding) return false;
    // Condition-specific: only show if no conditions restriction OR if user selected a matching condition
    if (s.conditions && s.conditions.length > 0) {
      const selectedConditions = (data.medicalConditions || []).filter(c => c !== 'None');
      return s.conditions.some(c => selectedConditions.includes(c));
    }
    return true; // general symptom — always show
  });
  const [severityErrors, setSeverityErrors] = useState([]);

  // Sync parent-level errors (from clicking Next) into local severityErrors state
  useEffect(() => {
    if (errors.symptomSeverity && errors.symptomSeverity.length > 0) {
      setSeverityErrors(errors.symptomSeverity);
    }
  }, [errors.symptomSeverity]);

  // symptomKey = "ConditionName::SymptomName"
  const toggleSymptom = (symptomKey) => {
    if (symptomKey === 'No current symptoms') {
      onChange('symptoms', selectedSymptoms.includes('No current symptoms') ? [] : ['No current symptoms']);
      onChange('symptomSeverity', {});
      setSeverityErrors([]);
      return;
    }
    const filtered = selectedSymptoms.filter(x => x !== 'No current symptoms');
    const isChecked = filtered.includes(symptomKey);

    // If trying to CHECK a new symptom, block if any existing symptom is missing severity
    if (!isChecked) {
      const missingSeverity = filtered.filter(sym => !symptomSeverity[sym]);
      if (missingSeverity.length > 0) {
        // Scroll to first symptom missing severity
        const firstMissing = missingSeverity[0];
        const el = symptomRowRefs.current[firstMissing];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Set React state so the warning message renders
        setSeverityErrors(missingSeverity);
        return;
      }
    }

    const next = isChecked
      ? filtered.filter((x) => x !== symptomKey)
      : [...filtered, symptomKey];
    onChange('symptoms', next);
    if (isChecked) {
      const newSev = { ...symptomSeverity };
      delete newSev[s];
      onChange('symptomSeverity', newSev);
      // Clear error for this symptom when it's unchecked
      setSeverityErrors(prev => prev.filter(e => e !== s));
    }
  };

  const setSeverity = (symptomKey, level) => {
    onChange('symptomSeverity', { ...symptomSeverity, [symptomKey]: level });
    // Clear the error for this symptom once severity is selected
    setSeverityErrors(prev => prev.filter(s => s !== symptomKey));
  };

  const noSymptoms = selectedSymptoms.includes('No current symptoms');

  return (
    <div className="step-body">

      {/* ── Medical Information ── */}
      <h3 className="step-section-title">Medical Information</h3>
      <p className="step-hint">Medical Conditions <span className="field-hint">(select all that apply)</span></p>

      {conditionGroups.map(({ group, items }) => (
        <div key={group} className="condition-group">
          <p className="condition-group-label">{group}</p>
          <div className="checkbox-grid-2">
            {items.map((c) => (
              <label key={c} className="checkbox-label condition-label">
                <input
                  type="checkbox"
                  checked={(data.medicalConditions || []).includes(c)}
                  onChange={() => toggleCondition(c)}
                />
                {c}
                <ConditionTooltip condition={c} openCondition={openCondition} onToggle={setOpenCondition} />
              </label>
            ))}
          </div>
        </div>
      ))}

      <label className="checkbox-label" style={{ marginTop: '8px' }}>
        <input
          type="checkbox"
          checked={(data.medicalConditions || []).includes('None')}
          onChange={() => toggleCondition('None')}
        />
        None
      </label>

      {showPregnancy && (
        <div className="step-field" style={{ marginTop: '20px' }}>
          <label>Pregnancy &amp; Breastfeeding</label>
          <div className="pregnancy-grid">
            <div className="pregnancy-row">
              <span className="pregnancy-label">Are you currently pregnant?</span>
              <div className="radio-group">
                {['Yes', 'No'].map(opt => (
                  <label key={opt} className="radio-label">
                    <input type="radio" name="isPregnant" value={opt}
                      checked={data.isPregnant === opt}
                      onChange={() => onChange('isPregnant', opt)} />
                    {opt}
                  </label>
                ))}
              </div>
            </div>
            <div className="pregnancy-row">
              <span className="pregnancy-label">Are you currently breastfeeding?</span>
              <div className="radio-group">
                {['Yes', 'No'].map(opt => (
                  <label key={opt} className="radio-label">
                    <input type="radio" name="isBreastfeeding" value={opt}
                      checked={data.isBreastfeeding === opt}
                      onChange={() => onChange('isBreastfeeding', opt)} />
                    {opt}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Divider ── */}
      <div className="step-section-divider" />

      {/* Current Symptoms */}
      <h3 className="step-section-title">Current Symptoms</h3>

      {(() => {
        const selectedConditions = (data.medicalConditions || []).filter(c => c !== 'None');
        const hasConditions = selectedConditions.length > 0;

        const noneSelected = (data.medicalConditions || []).includes('None');

        if (!hasConditions && !noneSelected) {
          return (
            <div className="symptoms-no-conditions">
              <span className="symptoms-no-conditions-icon">&#128161;</span>
              <p>Select your medical conditions above to see relevant symptoms.</p>
            </div>
          );
        }

        if (!hasConditions && noneSelected) {
          return (
            <>
              <p className="step-hint">
                Select any general symptoms you are currently experiencing.
              </p>
              <div className="symptoms-list">
                <div className="symptom-condition-group">
                  <p className="symptom-condition-label">General Symptoms</p>
                  {GENERAL_SYMPTOMS.map((s) => {
                    const symptomKey = `General::${s}`;
                    const checked = selectedSymptoms.includes(symptomKey);
                    const activeSeverity = symptomSeverity[symptomKey];
                    const missingSeverity = checked && !activeSeverity && severityErrors.includes(symptomKey);
                    return (
                      <div
                        key={symptomKey}
                        ref={el => { symptomRowRefs.current[symptomKey] = el; }}
                        className={`symptom-row ${checked ? 'symptom-row-active' : ''} ${missingSeverity ? 'symptom-row-error' : ''}`}
                      >
                        <label className="checkbox-label">
                          <input type="checkbox" checked={checked}
                            onChange={() => toggleSymptom(symptomKey)} />
                          <span className="symptom-name">{s}</span>
                        </label>
                        {missingSeverity && (
                          <span className="severity-required-inline">Please select a severity level to proceed</span>
                        )}
                        {checked && (
                          <div className="severity-wrap">
                            <div className="severity-group">
                              {SEVERITY_OPTIONS.map((level) => (
                                <button key={`${symptomKey}-${level}`} type="button"
                                  className={`severity-btn severity-${level.toLowerCase()} ${activeSeverity === level ? 'severity-active' : ''}`}
                                  onClick={() => setSeverity(symptomKey, level)}>
                                  {level}
                                </button>
                              ))}
                            </div>
                            {activeSeverity && (
                              <p className="severity-desc">
                                <strong>{s} &mdash; {activeSeverity}:</strong>{' '}
                                {SEVERITY_DESCRIPTIONS[s]?.[activeSeverity] || ''}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <label className="checkbox-label no-symptoms-for-condition" style={{ marginTop: '10px' }}>
                    <input type="checkbox" checked={noSymptoms}
                      onChange={() => toggleSymptom('No current symptoms')} />
                    None — I have no current symptoms
                  </label>
                </div>
              </div>
            </>
          );
        }

        const noSymptomsPerCondition = data.noSymptomsForConditions || [];

        const toggleNoSymptomsForCondition = (condition) => {
          const current = noSymptomsPerCondition;
          const isChecking = !current.includes(condition);
          const updated = isChecking
            ? [...current, condition]
            : current.filter(c => c !== condition);
          onChange('noSymptomsForConditions', updated);

          if (isChecking) {
            // Clear all symptoms AND their severities for this condition
            const updatedSymptoms = (data.symptoms || []).filter(s => !s.startsWith(condition + '::'));
            const updatedSeverity = Object.fromEntries(
              Object.entries(data.symptomSeverity || {}).filter(([key]) => !key.startsWith(condition + '::'))
            );
            onChange('symptoms', updatedSymptoms);
            onChange('symptomSeverity', updatedSeverity);
          }
        };

        return (
          <>
            <p className="step-hint">
              Showing symptoms for your selected conditions. Select all that apply.
            </p>

            <div className="symptoms-list">
              {selectedConditions.map((condition) => {
                const conditionSymptoms = ALL_SYMPTOMS.filter(s => {
                  if (s.conditions.length === 0) return false;
                  if (!s.conditions.includes(condition)) return false;
                  if (s.genders.length > 0 && !s.genders.includes(gender) && gender !== '') return false;
                  if (s.name === 'Low Libido' && isPregnantOrBreastfeeding) return false;
                  return true;
                });

                if (conditionSymptoms.length === 0) return null;

                const noSymptomsChecked = noSymptomsPerCondition.includes(condition);

                return (
                  <div key={condition} className="symptom-condition-group">
                    <p className="symptom-condition-label">For {condition}</p>

                    {!noSymptomsChecked && conditionSymptoms.map(({ name: s }) => {
                      const symptomKey = `${condition}::${s}`;
                      const checked = selectedSymptoms.includes(symptomKey);
                      const activeSeverity = symptomSeverity[symptomKey];
                      const missingSeverity = checked && !activeSeverity && severityErrors.includes(symptomKey);
                      return (
                        <div
                          key={symptomKey}
                          ref={el => { symptomRowRefs.current[symptomKey] = el; }}
                          className={`symptom-row ${checked ? 'symptom-row-active' : ''} ${missingSeverity ? 'symptom-row-error' : ''}`}
                        >
                          <label className="checkbox-label">
                            <input type="checkbox" checked={checked}
                              onChange={() => toggleSymptom(symptomKey)} />
                            <span className="symptom-name">{s}</span>
                          </label>
                          {missingSeverity && (
                            <span className="severity-required-inline">Please select a severity level to proceed</span>
                          )}
                          {checked && (
                            <div className="severity-wrap">
                              <div className="severity-group">
                                {SEVERITY_OPTIONS.map((level) => (<button key={`${symptomKey}-${level}`} type="button"
                                    className={`severity-btn severity-${level.toLowerCase()} ${activeSeverity === level ? 'severity-active' : ''}`}
                                    onClick={() => setSeverity(symptomKey, level)}>
                                    {level}
                                  </button>
                                ))}
                              </div>
                              {activeSeverity && (
                                <p className="severity-desc">
                                  <strong>{s} &mdash; {activeSeverity}:</strong>{' '}
                                  {SEVERITY_DESCRIPTIONS[s]?.[activeSeverity] || ''}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <label className="checkbox-label no-symptoms-for-condition">
                      <input type="checkbox"
                        checked={noSymptomsChecked}
                        onChange={() => toggleNoSymptomsForCondition(condition)} />
                      No symptoms for {condition}
                    </label>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ── Step 4: Lifestyle & Additional Details ─────────────────────────────────
function Step4Lifestyle({ data, onChange, errors }) {
  const toggleLifestyle = (habit) => {
    const current = data.lifestyleHabits || [];
    if (habit === 'None') {
      onChange('lifestyleHabits', current.includes('None') ? [] : ['None']);
      return;
    }
    const filtered = current.filter(x => x !== 'None');
    onChange('lifestyleHabits', filtered.includes(habit)
      ? filtered.filter(x => x !== habit)
      : [...filtered, habit]);
  };

  return (
    <div className="step-body">
      <h3 className="step-section-title">Lifestyle &amp; Additional Details</h3>

      {/* Sleep Quality */}
      <div className="step-field">
        <label>Sleep Quality</label>
        <div className="radio-group flex-wrap">
          {SLEEP_OPTIONS.map(({ value, label }) => (
            <label key={value} className="radio-label">
              <input type="radio" name="sleepQuality" value={value}
                checked={data.sleepQuality === value}
                onChange={() => onChange('sleepQuality', value)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Daily Water Intake */}
      <div className="step-field">
        <label>Daily Water Intake <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {WATER_OPTIONS.map(({ value, label }) => (
            <label key={value} className="radio-label">
              <input type="radio" name="waterIntake" value={value}
                checked={data.waterIntake === value}
                onChange={() => onChange('waterIntake', value)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Lifestyle Habits */}
      <div className="step-field">
        <label>Lifestyle Habits <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['Smoking', 'Alcohol', 'None'].map((habit) => (
            <label key={habit} className="checkbox-label">
              <input type="checkbox"
                checked={(data.lifestyleHabits || []).includes(habit)}
                onChange={() => toggleLifestyle(habit)} />
              {habit}
            </label>
          ))}
        </div>
      </div>

      {/* Current Supplement Usage */}
      <hr className="step4-divider" />
      <div className="step-field">
        <label>Are you currently taking any supplements?</label>
        <div className="radio-group">
          {['Yes', 'No'].map((opt) => (
            <label key={opt} className="radio-label">
              <input type="radio" name="takingSupplements" value={opt}
                checked={data.takingSupplements === opt}
                onChange={() => onChange('takingSupplements', opt)} />
              {opt}
            </label>
          ))}
        </div>
        {data.takingSupplements === 'Yes' && (
          <textarea
            placeholder="List the supplements you're currently taking (e.g. Vitamin D 2000 IU, Fish Oil 1g)"
            value={data.currentSupplements || ''}
            onChange={(e) => onChange('currentSupplements', e.target.value)}
            rows={2} style={{ marginTop: '8px' }}
          />
        )}
      </div>

      {/* Recent Blood Test */}
      <div className="step-field">
        <label>Have you had a recent blood test?</label>
        <div className="radio-group">
          {['Yes', 'No'].map((opt) => (
            <label key={opt} className="radio-label">
              <input type="radio" name="recentBloodTest" value={opt}
                checked={data.recentBloodTest === opt}
                onChange={() => onChange('recentBloodTest', opt)} />
              {opt}
            </label>
          ))}
        </div>
        {data.recentBloodTest === 'Yes' && (
          <textarea
            placeholder="Share what your results showed — e.g. 'Low vitamin D (18 ng/mL), low ferritin (12), normal B12'"
            value={data.bloodTestResults || ''}
            onChange={(e) => onChange('bloodTestResults', e.target.value)}
            rows={3} style={{ marginTop: '8px', resize: 'vertical' }}
          />
        )}
      </div>

      <div className="step-row">
        <div className={`step-field ${errors.currentMedications ? 'field-error' : ''}`}>
          <label>Current Medications <span className="field-hint">(optional)</span></label>
          <textarea
            placeholder="List any medications you're currently taking"
            value={data.currentMedications || ''}
            onChange={(e) => onChange('currentMedications', e.target.value)}
            rows={3} />
          {errors.currentMedications && <span className="field-error-msg">{errors.currentMedications}</span>}
        </div>
        <div className={`step-field ${errors.allergies ? 'field-error' : ''}`}>
          <label>Known Allergies <span className="field-hint">(optional)</span></label>
          <textarea
            placeholder="List any known allergies (food, medication, etc.)"
            value={data.allergies || ''}
            onChange={(e) => onChange('allergies', e.target.value)}
            rows={3} />
          {errors.allergies && <span className="field-error-msg">{errors.allergies}</span>}
        </div>
      </div>

      {/* Sun Exposure */}
      <hr className="step4-divider" />
      <div className="step-field">
        <label>Daily Sun Exposure <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['None', '< 15 min', '15–30 min', '30–60 min', '1 hr+'].map((opt) => (
            <label key={opt} className="radio-label">
              <input type="radio" name="sunExposure" value={opt}
                checked={data.sunExposure === opt}
                onChange={() => onChange('sunExposure', opt)} />
              {opt}
            </label>
          ))}
        </div>
      </div>

      {/* Protein Intake */}
      <div className="step-field">
        <label>Daily Protein Intake <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['Very Low (< 50g)', 'Low (50–80g)', 'Moderate (80–120g)', 'High (120g+)', 'Not sure'].map((opt) => (
            <label key={opt} className="radio-label">
              <input type="radio" name="proteinIntake" value={opt}
                checked={data.proteinIntake === opt}
                onChange={() => onChange('proteinIntake', opt)} />
              {opt}
            </label>
          ))}
        </div>
      </div>

      {/* Health Description */}
      <div className="step-field">
        <label>Describe Your Current Health Concerns <span className="field-hint">(optional)</span></label>
        <textarea
          placeholder="Describe how you've been feeling lately in your own words — e.g. 'I've been feeling exhausted even after 8 hours of sleep, my joints ache in the morning, and I feel foggy at work...'"
          value={data.feelingDescription || ''}
          onChange={(e) => onChange('feelingDescription', e.target.value)}
          rows={4} style={{ resize: 'vertical' }}
        />
        <span className="field-hint" style={{ marginTop: '4px', display: 'block' }}>
          The more detail you provide, the more personalized your recommendations will be.
        </span>
      </div>
    </div>
  );
}

// ── Validation per step ────────────────────────────────────────────────────
function validateStep(step, formData) {
  const errors = {};

  if (step === 1) {
    if (!formData.age || Number(formData.age) < 1 || Number(formData.age) > 120)
      errors.age = 'Please enter a valid age.';
    if (!formData.gender)
      errors.gender = 'Please select a gender.';

    const weightUnit = formData.weightUnit || 'kg';
    const w = Number(formData.weight);
    if (!formData.weight || isNaN(w) || w < 1)
      errors.weight = 'Please enter a valid weight.';
    else if (weightUnit === 'kg' && w > 500)
      errors.weight = 'Please enter a valid weight (max 500 kg).';
    else if (weightUnit === 'lbs' && w > 1100)
      errors.weight = 'Please enter a valid weight (max 1100 lbs).';

    const heightUnit = formData.heightUnit || 'cm';
    if (heightUnit === 'cm') {
      if (!formData.height || Number(formData.height) < 30 || Number(formData.height) > 300)
        errors.height = 'Please enter a valid height (30–300 cm).';
    } else {
      if (!formData.heightFt || Number(formData.heightFt) < 1)
        errors.height = 'Please enter a valid height.';
    }

    // BMI sanity check (always uses stored cm/kg values)
    if (formData.weight && formData.height) {
      const weightKg = weightUnit === 'lbs' ? lbsToKg(formData.weight) : Number(formData.weight);
      const bmi = weightKg / ((Number(formData.height) / 100) ** 2);
      if (bmi < 5 || bmi > 80)
        errors.weight = 'The height/weight combination seems impossible. Please check your values.';
    }
  }

  if (step === 3) {
    const symptoms = (formData.symptoms || []).filter(s => s !== 'No current symptoms');
    const severity = formData.symptomSeverity || {};
    const missing = symptoms.filter(s => !severity[s]);
    if (missing.length > 0) {
      errors.symptomSeverity = missing; // array of symptom names missing severity
    }
  }

  if (step === 4) {
    if (formData.currentMedications && isSpam(formData.currentMedications))
      errors.currentMedications = 'Please enter a valid medication name or leave blank.';
    if (formData.allergies && isSpam(formData.allergies))
      errors.allergies = 'Please enter a valid allergy or leave blank.';
  }

  return errors;
}

function hasMinimumData(formData) {
  const hasBasics = formData.age && formData.gender && formData.weight && formData.height;
  const hasSymptomOrGoal =
    (formData.symptoms && formData.symptoms.length > 0) ||
    (formData.healthGoals && formData.healthGoals.length > 0);
  return hasBasics && hasSymptomOrGoal;
}

// ── Main Assessment Page ───────────────────────────────────────────────────
const EMPTY_FORM = {
  age: '', gender: '', weight: '', weightUnit: 'kg',
  height: '', heightUnit: 'cm', heightFt: '', heightIn: '',
  activityLevel: '',
  dietType: '', healthGoals: [],
  symptoms: [], symptomSeverity: {},
  noSymptomsForConditions: [],
  stressLevel: '', sleepQuality: '', waterIntake: '',
  medicalConditions: [], currentMedications: '', allergies: '',
  lifestyleHabits: [],
  isPregnant: '', isBreastfeeding: '',
  // Keep pregnancyStatus for backward compat with backend
  pregnancyStatus: '',
  takingSupplements: '', currentSupplements: '',
  recentBloodTest: '',
  feelingDescription: '',
  sunExposure: '',
  proteinIntake: '',
  bloodTestResults: '',
};

function AssessmentPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const cardTopRef = useRef(null);
  const symptomRowRefs = useRef({});

  const [formData, setFormData] = useState(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      return saved ? { ...EMPTY_FORM, ...JSON.parse(saved) } : EMPTY_FORM;
    } catch {
      return EMPTY_FORM;
    }
  });

  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(formData));
  }, [formData]);

  const handleChange = (field, value) => {
    setFormData((prev) => {
      const updated = { ...prev, [field]: value };
      // Keep pregnancyStatus in sync for backend compatibility
      if (field === 'isPregnant' || field === 'isBreastfeeding') {
        const pregnant = field === 'isPregnant' ? value : updated.isPregnant;
        const breastfeeding = field === 'isBreastfeeding' ? value : updated.isBreastfeeding;
        if (pregnant === 'Yes') updated.pregnancyStatus = 'Pregnant';
        else if (breastfeeding === 'Yes') updated.pregnancyStatus = 'Breastfeeding';
        else updated.pregnancyStatus = 'Not applicable';

        // Remove Low Libido from symptoms if pregnant or breastfeeding
        if (pregnant === 'Yes' || breastfeeding === 'Yes') {
          updated.symptoms = (updated.symptoms || []).filter(s => s !== 'Low Libido');
          const { 'Low Libido': _removed, ...restSeverity } = updated.symptomSeverity || {};
          updated.symptomSeverity = restSeverity;
        }
      }
      return updated;
    });
    if (errors[field]) setErrors(prev => { const e = { ...prev }; delete e[field]; return e; });
  };

  const handleNext = () => {
    const stepErrors = validateStep(step, formData);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      // Scroll to first symptom missing severity
      if (stepErrors.symptomSeverity?.length > 0) {
        const firstMissing = stepErrors.symptomSeverity[0];
        const el = symptomRowRefs.current[firstMissing];
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      return;
    }
    setErrors({});
    if (step < TOTAL_STEPS) setStep((s) => s + 1);
  };

  const handleBack = () => {
    setErrors({});
    if (step > 1) setStep((s) => s - 1);
    else {
      sessionStorage.removeItem(SESSION_KEY);
      setFormData(EMPTY_FORM);
      navigate('/');
    }
  };

  const handleSubmit = async () => {
    setSubmitError('');
    const stepErrors = validateStep(step, formData);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    if (!hasMinimumData(formData)) {
      setSubmitError('Please complete at least your basic info (age, gender, height, weight) and select at least one symptom or health goal before submitting.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(formData));
      navigate('/login', { state: { fromAssessment: true } });
      return;
    }

    // Normalize weight to kg before sending to backend
    const weightUnit = formData.weightUnit || 'kg';
    const normalizedWeight = weightUnit === 'lbs'
      ? lbsToKg(formData.weight)
      : Number(formData.weight);

    // Strip "ConditionName::" prefix before sending to backend
    const rawSymptoms = formData.symptoms || [];
    const strippedSymptoms = rawSymptoms
      .filter(s => s !== 'No current symptoms')
      .map(s => s.includes('::') ? s.split('::')[1] : s);
    const uniqueSymptoms = [...new Set(strippedSymptoms)];

    const rawSeverity = formData.symptomSeverity || {};
    const strippedSeverity = {};
    const severityRank = { Mild: 1, Moderate: 2, Severe: 3 };
    Object.entries(rawSeverity).forEach(([key, val]) => {
      const symptomName = key.includes('::') ? key.split('::')[1] : key;
      if (!strippedSeverity[symptomName] || (severityRank[val] || 0) > (severityRank[strippedSeverity[symptomName]] || 0)) {
        strippedSeverity[symptomName] = val;
      }
    });

    const payload = { ...formData, weight: normalizedWeight, symptoms: uniqueSymptoms, symptomSeverity: strippedSeverity };

    setSubmitting(true);
    try {
      let assessmentId = null;
      let garbageFields = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const saveResult = await saveAssessment(payload);
          assessmentId = saveResult?.assessment?._id;
          garbageFields = saveResult?.garbageFields || [];
          if (assessmentId) break;
        } catch (saveErr) {
          console.error(`Assessment save attempt ${attempt} failed:`, saveErr.message);
        }
      }

      const recommendations = await getRecommendations(payload);

      if (assessmentId) {
        try {
          await saveAssessmentResults(assessmentId, recommendations);
        } catch (aiSaveErr) {
          console.error('AI results save error:', aiSaveErr.message);
        }
      }

      sessionStorage.removeItem(SESSION_KEY);
      navigate('/results', { state: { recommendations, assessment: payload, garbageFields } });
    } catch (err) {
      const msg = err.message || '';
      if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
        setSubmitError('Unable to connect. Please check your internet connection and try again.');
      } else {
        setSubmitError(err.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const progress = (step / TOTAL_STEPS) * 100;

  return (
    <div className="assessment-wrapper">
      <Navbar />
      <div className="assessment-container">
        <div className="assessment-header">
          <div>
            <h2 className="assessment-title">Health Assessment</h2>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <span className="step-counter">Step {step} of {TOTAL_STEPS}</span>
        </div>

        <div className="assessment-card" ref={cardTopRef}>
          {submitError && <p className="auth-error">{submitError}</p>}

          {step === 1 && <Step1 data={formData} onChange={handleChange} errors={errors} />}
          {step === 2 && <Step2 data={formData} onChange={handleChange} errors={errors} />}
          {step === 3 && <Step3Combined data={formData} onChange={handleChange} errors={errors} symptomRowRefs={symptomRowRefs} />}
          {step === 4 && <Step4Lifestyle data={formData} onChange={handleChange} errors={errors} />}

          <div className="assessment-footer">
            <button className="btn-cancel" onClick={handleBack}>
              ← {step === 1 ? 'Cancel' : 'Back'}
            </button>
            {step < TOTAL_STEPS ? (
              <button className="btn-next" onClick={handleNext}>Next →</button>
            ) : (
              <button className="btn-next" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Analyzing...' : 'Get Recommendations →'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AssessmentPage;
