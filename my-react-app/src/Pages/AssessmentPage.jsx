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

// Generic info tooltip — same style as DietTooltip, used for activity levels and health goals
function InfoTooltip({ id, text, openId, onToggle }) {
  const visible = openId === id;
  return (
    <span className="diet-tooltip-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="diet-info-btn"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(visible ? null : id); }}
        aria-label="More info"
      >
        ?
      </button>
      {visible && (
        <span className="diet-tooltip-box">
          {text}
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
  const [openActivity, setOpenActivity] = useState(null);
  const [openTooltip, setOpenTooltip] = useState(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Calculate age and load gender from user's data stored in localStorage (only for logged-in users)
  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      setIsLoggedIn(true);
      try {
        const user = JSON.parse(userStr);
        
        // Auto-calculate age from dateOfBirth
        if (user.dateOfBirth) {
          const birthDate = new Date(user.dateOfBirth);
          const today = new Date();
          let calculatedAge = today.getFullYear() - birthDate.getFullYear();
          const monthDiff = today.getMonth() - birthDate.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            calculatedAge--;
          }
          // Only update if age is not already set or is different
          if (data.age !== String(calculatedAge)) {
            onChange('age', String(calculatedAge));
          }
        }
        
        // Auto-load gender from user account
        if (user.gender && data.gender !== user.gender) {
          onChange('gender', user.gender);
        }
      } catch (err) {
        console.error('Error loading user data:', err);
      }
    } else {
      setIsLoggedIn(false);
    }
  }, []); // Run once on mount

  useEffect(() => {
    if (!openActivity) return;
    const handleClick = () => setOpenActivity(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openActivity]);

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
      {/* Section Header with Icon */}
      <div className="section-header-with-icon">
        <svg className="section-icon section-icon-green" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z" fill="currentColor"/>
        </svg>
        <h3 className="section-title">Basic Information</h3>
      </div>
      <div className="section-divider section-divider-green"></div>

      {/* Card-based layout: Demographics and Body Measurements */}
      <div className="info-cards-row">
        {/* Left card: Demographics */}
        <div className="info-card demographics-card">
          <div className="card-header">
            <svg className="card-icon card-icon-green" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z" fill="currentColor"/>
            </svg>
            <h4 className="card-title">Demographics</h4>
          </div>

          {/* Age — auto-calculated and read-only for logged-in users, editable for guests */}
          <div id="field-age" className={`card-field ${errors.age ? 'field-error' : ''}`}>
            <label>Age <span className="required-star">*</span>
              <div className="diet-tooltip-wrap">
                <button
                  type="button"
                  className="diet-info-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenTooltip(openTooltip === 'age' ? null : 'age');
                  }}
                  title="Why is age important?"
                >
                  ?
                </button>
                {openTooltip === 'age' && (
                  <div className="diet-tooltip-box">
                    <span>
                      {isLoggedIn 
                        ? 'Age is automatically calculated from your date of birth. '
                        : 'Enter your age. '
                      }
                      Our AI adjusts supplement recommendations based on your age.
                      {age > 0 && age < 13 && ' As a child (under 13), you will receive pediatric doses tailored for growth and development.'}
                      {age >= 13 && age < 18 && ' As a teen (13-17), you will receive adolescent doses supporting growth, energy, and hormonal balance.'}
                      {age >= 18 && age < 65 && ' As an adult (18-64), you will receive standard doses optimized for overall health and wellness.'}
                      {age >= 65 && ' As a senior (65+), you will receive age-appropriate recommendations focusing on bone health, cognitive function, and energy.'}
                    </span>
                    <button
                      type="button"
                      className="diet-tooltip-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenTooltip(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </label>
            <input
              type="number"
              placeholder="Enter your age"
              value={data.age}
              min={1}
              max={120}
              className={isLoggedIn ? 'age-readonly' : ''}
              readOnly={isLoggedIn}
              disabled={isLoggedIn}
              onChange={(e) => !isLoggedIn && onChange('age', e.target.value)}
              onBlur={(e) => !isLoggedIn && onChange('age', clamp(e.target.value, 1, 120))}
            />
            {errors.age && <span className="field-error-msg">{errors.age}</span>}
          </div>

          {/* Gender — auto-loaded and read-only for logged-in users, editable for guests */}
          <div id="field-gender" className={`card-field ${errors.gender ? 'field-error' : ''}`}>
            <label>Gender <span className="required-star">*</span>
              <div className="diet-tooltip-wrap">
                <button
                  type="button"
                  className="diet-info-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenTooltip(openTooltip === 'gender' ? null : 'gender');
                  }}
                  title="Why is gender important?"
                >
                  ?
                </button>
                {openTooltip === 'gender' && (
                  <div className="diet-tooltip-box">
                    <span>
                      {isLoggedIn 
                        ? 'Gender is automatically loaded from your account. '
                        : 'Select your gender. '
                      }
                      Our AI tailors supplement recommendations based on biological sex differences. Males and females have different nutritional needs for hormones, bone density, iron levels, and reproductive health.
                    </span>
                    <button
                      type="button"
                      className="diet-tooltip-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenTooltip(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </label>
            <div className="gender-pill-group">
              {['Male', 'Female'].map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`gender-pill ${data.gender === g ? 'gender-pill-active' : ''} ${isLoggedIn ? 'gender-pill-readonly' : ''}`}
                  disabled={isLoggedIn}
                  onClick={() => {
                    if (!isLoggedIn) {
                      onChange('gender', g);
                      if (g !== 'Female') {
                        onChange('isPregnant', '');
                        onChange('isBreastfeeding', '');
                      }
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

        {/* Right card: Body Measurements */}
        <div className="info-card measurements-card">
          <div className="card-header">
            <svg className="card-icon card-icon-blue" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 17.25V21H6.75L17.81 9.94L14.06 6.19L3 17.25ZM20.71 7.04C21.1 6.65 21.1 6.02 20.71 5.63L18.37 3.29C17.98 2.9 17.35 2.9 16.96 3.29L15.13 5.12L18.88 8.87L20.71 7.04Z" fill="currentColor"/>
            </svg>
            <h4 className="card-title">Body Measurements</h4>
          </div>

          {/* Weight with unit toggle */}
          <div id="field-weight" className={`card-field ${errors.weight ? 'field-error' : ''}`}>
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
          <div id="field-height" className={`card-field ${errors.height ? 'field-error' : ''}`}>
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
      </div>

      {showActivityLevel && (
        <div id="field-activityLevel" className="step-field">
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
                  <InfoTooltip id={value} text={description} openId={openActivity} onToggle={setOpenActivity} />
                </label>
              </div>
            ))}
          </div>
          {errors.activityLevel && <span className="field-error-msg">{errors.activityLevel}</span>}
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
function Step2({ data, onChange, errors = {} }) {
  const age = Number(data.age) || 0;
  const isChild = age > 0 && age < 13;
  const [openGoal, setOpenGoal] = useState(null);
  const [openDiet, setOpenDiet] = useState(null);

  // Close tooltip when clicking anywhere outside it
  useEffect(() => {
    if (!openDiet) return;
    const handleClick = () => setOpenDiet(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openDiet]);

  useEffect(() => {
    if (!openGoal) return;
    const handleClick = () => setOpenGoal(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openGoal]);

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
      {/* Section Header with Icon */}
      <div className="section-header-with-icon">
        <svg className="section-icon section-icon-purple" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM13 17H11V15H13V17ZM13 13H11V7H13V13Z" fill="currentColor"/>
        </svg>
        <h3 className="section-title">Diet &amp; Health Goals</h3>
      </div>
      <div className="section-divider section-divider-purple"></div>

      {/* Diet type — 6 options in a 3-col grid with info tooltips */}
      <div id="field-dietType" className="step-field">
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
        {errors.dietType && <span className="field-error-msg">{errors.dietType}</span>}
      </div>

      {/* Health goals grouped by category */}
      <div id="field-healthGoals" className="step-field" style={{ marginTop: '24px' }}>
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
                                {description && <InfoTooltip id={label} text={description} openId={openGoal} onToggle={setOpenGoal} />}
                              </label>
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
                            {description && <InfoTooltip id={label} text={description} openId={openGoal} onToggle={setOpenGoal} />}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
        {errors.healthGoals && <span className="field-error-msg">{errors.healthGoals}</span>}
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
  { name: 'Low Libido',                    genders: ['Male'],           conditions: ['Diabetes', 'Hypertension (High Blood Pressure)', 'Depression', 'Thyroid Disorders'] },
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
        ...(data.gender === 'Female' ? ['PCOS'] : []),
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

  const showPregnancy = data.gender === 'Female';

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
      {/* Section Header with Icon - Medical Information */}
      <div className="section-header-with-icon">
        <svg className="section-icon section-icon-red" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM17 13H13V17H11V13H7V11H11V7H13V11H17V13Z" fill="currentColor"/>
        </svg>
        <h3 className="section-title">Medical Information</h3>
      </div>
      <div className="section-divider section-divider-red"></div>

      <p id="field-medicalConditions" className="step-hint">Medical Conditions <span className="field-hint">(select all that apply)</span></p>

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
      {errors.medicalConditions && <span className="field-error-msg">{errors.medicalConditions}</span>}

      {/* ── Divider ── */}
      <div className="step-section-divider" />

      {/* Section Header with Icon - Current Symptoms */}
      <div className="section-header-with-icon">
        <svg className="section-icon section-icon-orange" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM13 17H11V11H13V17ZM13 9H11V7H13V9Z" fill="currentColor"/>
        </svg>
        <h3 className="section-title">Current Symptoms</h3>
      </div>
      <div className="section-divider section-divider-orange"></div>

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
              <span id="field-generalSymptoms"></span>
              {errors.generalSymptoms && <span className="field-error-msg">{errors.generalSymptoms}</span>}
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
                  <div key={condition} id={`field-condition-${condition}`} className="symptom-condition-group">
                    <p className="symptom-condition-label">For {condition}</p>
                    {errors.symptomsRequired?.includes(condition) && (
                      <span className="field-error-msg" style={{ display: 'block', marginBottom: '8px' }}>Please select symptoms or mark 'No symptoms for {condition}'.</span>
                    )}

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

// ── Step 4: Lifestyle & Medical Information ───────────────────────────────
function Step4Lifestyle({ data, onChange, errors }) {
  const [showMedicationsInput, setShowMedicationsInput] = useState(false);
  const [showAllergiesInput, setShowAllergiesInput] = useState(false);

  const toggleLifestyle = (habit) => {
    const current = data.lifestyleHabits || [];
    if (habit === 'None') {
      onChange('lifestyleHabits', current.includes('None') ? [] : ['None']);
      onChange('recreationalDrugTypes', '');
      return;
    }
    const filtered = current.filter(x => x !== 'None');
    const isRemoving = filtered.includes(habit);
    onChange('lifestyleHabits', isRemoving
      ? filtered.filter(x => x !== habit)
      : [...filtered, habit]);
    if (habit === 'Recreational Drugs' && isRemoving) {
      onChange('recreationalDrugTypes', '');
    }
  };

  // Toggle "None" checkbox for medications
  const handleMedicationsNoneChange = (checked) => {
    if (checked) {
      onChange('currentMedications', 'None');
      setShowMedicationsInput(false);
    } else {
      onChange('currentMedications', '');
      setShowMedicationsInput(true);
    }
  };

  // Toggle "None" checkbox for allergies
  const handleAllergiesNoneChange = (checked) => {
    if (checked) {
      onChange('allergies', 'None');
      setShowAllergiesInput(false);
    } else {
      onChange('allergies', '');
      setShowAllergiesInput(true);
    }
  };

  // Initialize state based on existing data
  useEffect(() => {
    if (data.currentMedications && data.currentMedications.trim() && data.currentMedications !== 'None') {
      setShowMedicationsInput(true);
    }
    if (data.allergies && data.allergies.trim() && data.allergies !== 'None') {
      setShowAllergiesInput(true);
    }
  }, [data.currentMedications, data.allergies]);

  return (
    <div className="step-body">
      {/* Required fields notice at top */}
      <div className="required-notice">
        Fields marked with <span className="required-star">*</span> are required.
      </div>

      {/* ===== LIFESTYLE SECTION ===== */}
      <div className="section-header-with-icon">
        <svg className="section-icon section-icon-teal" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 20C7.59 20 4 16.41 4 12C4 7.59 7.59 4 12 4C16.41 4 20 7.59 20 12C20 16.41 16.41 20 12 20ZM12.5 7H11V13L16.25 16.15L17 14.92L12.5 12.25V7Z" fill="currentColor"/>
        </svg>
        <h3 className="section-title">Lifestyle</h3>
      </div>
      <div className="section-divider section-divider-teal"></div>

      {/* Sleep Quality */}
      <div id="field-sleepQuality" className="step-field">
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
        {errors.sleepQuality && <span className="field-error-msg">{errors.sleepQuality}</span>}
      </div>

      {/* Daily Water Intake */}
      <div className="step-field">
        <label>Daily Water Intake</label>
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
        <label>Lifestyle Habits</label>
        <div className="checkbox-group">
          {['Smoking', 'Alcohol'].map((habit) => (
            <label key={habit} className="checkbox-label">
              <input type="checkbox"
                checked={(data.lifestyleHabits || []).includes(habit)}
                onChange={() => toggleLifestyle(habit)} />
              {habit}
            </label>
          ))}
          <label className="checkbox-label">
            <input type="checkbox"
              checked={(data.lifestyleHabits || []).includes('Recreational Drugs')}
              onChange={() => toggleLifestyle('Recreational Drugs')} />
            Recreational Drugs
            {(data.lifestyleHabits || []).includes('Recreational Drugs') && (
              <span className="required-star">*</span>
            )}
          </label>
        </div>
        {/* Conditional input for Recreational Drugs - REQUIRED when checked */}
        {(data.lifestyleHabits || []).includes('Recreational Drugs') && (
          <textarea
            placeholder="e.g. Cannabis, MDMA, Cocaine — list any recreational drugs you use"
            value={data.recreationalDrugTypes || ''}
            onChange={(e) => onChange('recreationalDrugTypes', e.target.value)}
            rows={3}
            style={{ marginTop: '12px', marginBottom: '12px' }}
          />
        )}
        {errors.recreationalDrugTypes && <span className="field-error-msg" style={{ display: 'block', marginBottom: '8px' }}>{errors.recreationalDrugTypes}</span>}
        <div className="checkbox-group">
          <label className="checkbox-label">
            <input type="checkbox"
              checked={(data.lifestyleHabits || []).includes('None')}
              onChange={() => toggleLifestyle('None')} />
            None
          </label>
        </div>
        {errors.lifestyleHabits && <span className="field-error-msg">{errors.lifestyleHabits}</span>}
      </div>

      {/* Daily Sun Exposure */}
      <div className="step-field">
        <label>Daily Sun Exposure</label>
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
        <label>Daily Protein Intake</label>
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

      {/* Step Section Divider */}
      <div className="step-section-divider" />

      {/* ===== HEALTH BACKGROUND SECTION ===== */}
      <div className="section-header-with-icon">
        <svg className="section-icon section-icon-purple" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 3H14.82C14.4 1.84 13.3 1 12 1C10.7 1 9.6 1.84 9.18 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM12 3C12.55 3 13 3.45 13 4C13 4.55 12.55 5 12 5C11.45 5 11 4.55 11 4C11 3.45 11.45 3 12 3ZM7 7H17V9H7V7ZM7 11H17V13H7V11ZM7 15H14V17H7V15Z" fill="currentColor"/>
        </svg>
        <h3 className="section-title">Health Background</h3>
      </div>
      <div className="section-divider section-divider-purple"></div>

      {/* Currently Taking Supplements - REQUIRED */}
      <div className="step-field">
        <label>Currently Taking Supplements? <span className="required-star">*</span></label>
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
        {/* Conditional input - If Yes */}
        {data.takingSupplements === 'Yes' && (
          <textarea
            placeholder="List the supplements you're currently taking (e.g. Vitamin D 2000 IU, Fish Oil 1g)"
            value={data.currentSupplements || ''}
            onChange={(e) => onChange('currentSupplements', e.target.value)}
            rows={3}
            style={{ marginTop: '12px', resize: 'vertical' }}
          />
        )}
        {errors.takingSupplements && <span className="field-error-msg">{errors.takingSupplements}</span>}
      </div>

      {/* Recent Blood Test - REQUIRED */}
      <div className="step-field">
        <label>Recent Blood Test? <span className="required-star">*</span></label>
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
        {/* Conditional input - If Yes */}
        {data.recentBloodTest === 'Yes' && (
          <textarea
            placeholder="Share what your results showed — e.g. 'Low vitamin D (18 ng/mL), low ferritin (12), normal B12'"
            value={data.bloodTestResults || ''}
            onChange={(e) => onChange('bloodTestResults', e.target.value)}
            rows={3}
            style={{ marginTop: '12px', resize: 'vertical' }}
          />
        )}
        {errors.recentBloodTest && <span className="field-error-msg">{errors.recentBloodTest}</span>}
      </div>

      {/* Current Medications - REQUIRED */}
      <div id="field-currentMedications" className={`step-field ${errors.currentMedications ? 'field-error' : ''}`}>
        <label>Current Medications <span className="required-star">*</span></label>
        {/* Show textarea unless "None" is checked */}
        {data.currentMedications !== 'None' && (
          <textarea
            placeholder="List any medications you're currently taking"
            value={data.currentMedications === 'None' ? '' : (data.currentMedications || '')}
            onChange={(e) => onChange('currentMedications', e.target.value)}
            rows={3}
            style={{ marginBottom: '12px' }}
          />
        )}
        <div className="checkbox-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={data.currentMedications === 'None'}
              onChange={(e) => {
                if (e.target.checked) {
                  onChange('currentMedications', 'None');
                  setShowMedicationsInput(false);
                } else {
                  onChange('currentMedications', '');
                  setShowMedicationsInput(true);
                }
              }}
            />
            None
          </label>
        </div>
        {errors.currentMedications && <span className="field-error-msg">{errors.currentMedications}</span>}
      </div>

      {/* Known Allergies - REQUIRED */}
      <div id="field-allergies" className={`step-field ${errors.allergies ? 'field-error' : ''}`}>
        <label>Known Allergies <span className="required-star">*</span></label>
        {/* Show textarea unless "None" is checked */}
        {data.allergies !== 'None' && (
          <textarea
            placeholder="List any known allergies (food, medication, etc.)"
            value={data.allergies === 'None' ? '' : (data.allergies || '')}
            onChange={(e) => onChange('allergies', e.target.value)}
            rows={3}
            style={{ marginBottom: '12px' }}
          />
        )}
        <div className="checkbox-group">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={data.allergies === 'None'}
              onChange={(e) => {
                if (e.target.checked) {
                  onChange('allergies', 'None');
                  setShowAllergiesInput(false);
                } else {
                  onChange('allergies', '');
                  setShowAllergiesInput(true);
                }
              }}
            />
            None
          </label>
        </div>
        {errors.allergies && <span className="field-error-msg">{errors.allergies}</span>}
      </div>

      {/* Pregnancy & Breastfeeding — only for Female - REQUIRED */}
      {data.gender === 'Female' && (
        <>
          <div className="subsection-header-with-icon" style={{ marginTop: '24px' }}>
            <svg className="subsection-icon subsection-icon-purple" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 11.75C6.66 11.75 4.75 9.84 4.75 7.5C4.75 5.16 6.66 3.25 9 3.25C11.34 3.25 13.25 5.16 13.25 7.5C13.25 9.84 11.34 11.75 9 11.75ZM15 12C15.55 12 16 11.55 16 11C16 10.45 15.55 10 15 10C14.45 10 14 10.45 14 11C14 11.55 14.45 12 15 12ZM15 14C12.79 14 11 12.21 11 10C11 9.45 11.45 9 12 9C12.55 9 13 9.45 13 10C13 11.1 13.9 12 15 12C16.1 12 17 11.1 17 10C17 9.45 17.45 9 18 9C18.55 9 19 9.45 19 10C19 12.21 17.21 14 15 14ZM9 13C5.69 13 3 15.69 3 19V20C3 20.55 3.45 21 4 21H14C14.55 21 15 20.55 15 20V19C15 15.69 12.31 13 9 13Z" fill="currentColor"/>
            </svg>
            <h4 className="subsection-title">Female-Specific Questions</h4>
          </div>
          <div className="subsection-divider subsection-divider-purple"></div>

          {/* Pregnant */}
          <div className="step-field">
            <label>Pregnant? <span className="required-star">*</span></label>
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
            {errors.isPregnant && <span className="field-error-msg">{errors.isPregnant}</span>}
          </div>

          {/* Breastfeeding */}
          <div className="step-field">
            <label>Breastfeeding? <span className="required-star">*</span></label>
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
            {errors.isBreastfeeding && <span className="field-error-msg">{errors.isBreastfeeding}</span>}
          </div>
        </>
      )}

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
        errors.height = 'Please enter a valid height (30–00 cm).';
    } else {
      if (!formData.heightFt || Number(formData.heightFt) < 1)
        errors.height = 'Please enter a valid height.';
    }

    if (formData.weight && formData.height) {
      const weightKg = weightUnit === 'lbs' ? lbsToKg(formData.weight) : Number(formData.weight);
      const bmi = weightKg / ((Number(formData.height) / 100) ** 2);
      if (bmi < 5 || bmi > 80)
        errors.weight = 'The height/weight combination seems impossible. Please check your values.';
    }

    // Physical Activity Level required for users 13+
    const age = Number(formData.age) || 0;
    if (age >= 13 && !formData.activityLevel)
      errors.activityLevel = 'Please select your physical activity level.';
  }

  if (step === 2) {
    if (!formData.dietType)
      errors.dietType = 'Please select a diet type.';
    if (!formData.healthGoals || formData.healthGoals.length === 0)
      errors.healthGoals = 'Please select at least one health goal.';
  }

  if (step === 3) {
    // Must select at least one condition (including None)
    if (!formData.medicalConditions || formData.medicalConditions.length === 0)
      errors.medicalConditions = 'Please select your medical conditions, or select None.';

    const noneSelected = (formData.medicalConditions || []).includes('None');
    const selectedConditions = (formData.medicalConditions || []).filter(c => c !== 'None');

    // If None selected — must either select a general symptom OR check "None — no symptoms"
    if (noneSelected) {
      const hasGeneralSymptom = (formData.symptoms || []).some(s => s.startsWith('General::'));
      const markedNoSymptoms = (formData.symptoms || []).includes('No current symptoms');
      if (!hasGeneralSymptom && !markedNoSymptoms)
        errors.generalSymptoms = 'Please select your current symptoms, or mark that you have none.';
    }

    // If specific conditions selected — must either select symptoms or mark no symptoms for each
    if (selectedConditions.length > 0) {
      const noSymptomsFor = formData.noSymptomsForConditions || [];
      const conditionsWithoutAnswer = selectedConditions.filter(c => {
        const hasSymptom = (formData.symptoms || []).some(s => s.startsWith(c + '::'));
        const markedNoSymptoms = noSymptomsFor.includes(c);
        return !hasSymptom && !markedNoSymptoms;
      });
      if (conditionsWithoutAnswer.length > 0)
        errors.symptomsRequired = conditionsWithoutAnswer;
    }

    // All checked symptoms must have a severity
    const symptoms = (formData.symptoms || []).filter(s => s !== 'No current symptoms');
    const severity = formData.symptomSeverity || {};
    const missing = symptoms.filter(s => !severity[s]);
    if (missing.length > 0)
      errors.symptomSeverity = missing;
  }

  if (step === 4) {
    // Lifestyle Habits - OPTIONAL, but if "Recreational Drugs" is checked, drug types is REQUIRED
    if ((formData.lifestyleHabits || []).includes('Recreational Drugs')) {
      if (!formData.recreationalDrugTypes || !formData.recreationalDrugTypes.trim()) {
        errors.recreationalDrugTypes = 'Please specify which recreational drugs you use.';
      }
    }

    // Currently Taking Supplements - REQUIRED
    if (!formData.takingSupplements)
      errors.takingSupplements = 'Please indicate if you are taking supplements.';
    if (formData.takingSupplements === 'Yes' && !formData.currentSupplements?.trim())
      errors.takingSupplements = 'Please list the supplements you are taking.';

    // Recent Blood Test - REQUIRED
    if (!formData.recentBloodTest)
      errors.recentBloodTest = 'Please indicate if you have had a recent blood test.';

    // Current Medications - REQUIRED (accept "None" as valid)
    if (!formData.currentMedications || !formData.currentMedications.trim())
      errors.currentMedications = 'Please enter your current medications or select None.';
    else if (formData.currentMedications !== 'None' && isSpam(formData.currentMedications))
      errors.currentMedications = 'Please enter a valid medication name.';

    // Known Allergies - REQUIRED (accept "None" as valid)
    if (!formData.allergies || !formData.allergies.trim())
      errors.allergies = 'Please enter your known allergies or select None.';
    else if (formData.allergies !== 'None' && isSpam(formData.allergies))
      errors.allergies = 'Please enter a valid allergy.';

    // Female-specific - REQUIRED for females
    if (formData.gender === 'Female') {
      if (!formData.isPregnant)
        errors.isPregnant = 'Please indicate if you are pregnant.';
      if (!formData.isBreastfeeding)
        errors.isBreastfeeding = 'Please indicate if you are breastfeeding.';
    }
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
  recreationalDrugTypes: '',
  isPregnant: '', isBreastfeeding: '',
  // Keep pregnancyStatus for backward compat with backend
  pregnancyStatus: '',
  takingSupplements: '', currentSupplements: '',
  recentBloodTest: '',
  sunExposure: '',
  proteinIntake: '',
  bloodTestResults: '',
};

// ── AI Loading Step item (animated check-in) ──────────────────────────────
function AILoadingStep({ icon, label, delay }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div className={`ai-loading-step ${visible ? 'ai-loading-step-visible' : ''}`}>
      <span className="ai-loading-step-icon">{icon}</span>
      <span className="ai-loading-step-label">{label}</span>
      {visible && <span className="ai-loading-step-check">✓</span>}
    </div>
  );
}

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

  // Scroll to top whenever step changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

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

      // Scroll to the first error so the user sees what's missing
      const scrollToId = (id) => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };

      if (stepErrors.age)               scrollToId('field-age');
      else if (stepErrors.gender)        scrollToId('field-gender');
      else if (stepErrors.weight)        scrollToId('field-weight');
      else if (stepErrors.height)        scrollToId('field-height');
      else if (stepErrors.activityLevel) scrollToId('field-activityLevel');
      else if (stepErrors.dietType)      scrollToId('field-dietType');
      else if (stepErrors.healthGoals)   scrollToId('field-healthGoals');
      else if (stepErrors.medicalConditions) scrollToId('field-medicalConditions');
      else if (stepErrors.generalSymptoms)   scrollToId('field-generalSymptoms');
      else if (stepErrors.symptomsRequired?.length > 0) scrollToId(`field-condition-${stepErrors.symptomsRequired[0]}`);
      else if (stepErrors.symptomSeverity?.length > 0) {
        const firstMissing = stepErrors.symptomSeverity[0];
        const el = symptomRowRefs.current[firstMissing];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      // Scroll to the first error field in step 4
      const scrollToId = (id) => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      if (stepErrors.currentMedications)   scrollToId('field-currentMedications');
      else if (stepErrors.allergies)        scrollToId('field-allergies');
      else cardTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

        {/* ── AI Loading Screen ── */}
        {submitting && (
          <div className="ai-loading-screen">
            <div className="ai-loading-card">
              <div className="ai-loading-spinner">
                <div className="ai-spinner-ring" />
                <span className="ai-spinner-icon">🧬</span>
              </div>
              <h3 className="ai-loading-title">Analyzing Your Health Profile</h3>
              <p className="ai-loading-sub">Our AI is building your personalized supplement plan...</p>
              <div className="ai-loading-steps">
                <AILoadingStep icon="🔍" label="Reading your symptoms & goals" delay={0} />
                <AILoadingStep icon="💊" label="Matching supplements to your profile" delay={600} />
                <AILoadingStep icon="⚗️" label="Checking interactions & dosages" delay={1200} />
                <AILoadingStep icon="📋" label="Generating your wellness plan" delay={1800} />
              </div>
              <p className="ai-loading-note">This usually takes 10–20 seconds</p>
            </div>
          </div>
        )}

        <div className="assessment-card" ref={cardTopRef} style={{ display: submitting ? 'none' : undefined }}>
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
                Get Recommendations →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AssessmentPage;
