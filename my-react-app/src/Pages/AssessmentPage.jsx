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

// ── Step 1: Basic Information ──────────────────────────────────────────────
function Step1({ data, onChange, errors }) {
  const age = Number(data.age) || 0;
  const showActivityLevel = age === 0 || age >= 13;

  // Weight unit toggle — default kg
  const weightUnit = data.weightUnit || 'kg';
  // Height unit toggle — default cm
  const heightUnit = data.heightUnit || 'cm';

  const activityOptions = [
    { value: 'Sedentary', label: 'Sedentary / No Exercise' },
    { value: 'Light',     label: 'Light (1–3 days/week)' },
    { value: 'Moderate',  label: 'Moderate (3–5 days/week)' },
    { value: 'Very',      label: 'Very Active (6–7 days/week)' },
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
            {activityOptions.map(({ value, label }) => (
              <label key={value} className="radio-label">
                <input
                  type="radio"
                  name="activityLevel"
                  value={value}
                  checked={data.activityLevel === value}
                  onChange={() => onChange('activityLevel', value)}
                />
                {label}
              </label>
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

  // Health goals — removed "Management" and "Anti-Aging" options
  // Weight, Bone, Stress, Hormonal are kept but renamed to be clearer
  const adultGoals = [
    { label: 'Increase Energy',        group: 'General' },
    { label: 'Improve Sleep',          group: 'General' },
    { label: 'Boost Immunity',         group: 'General' },
    { label: 'Support Heart Health',   group: 'General' },
    { label: 'Digestive Health',       group: 'General' },
    { label: 'Muscle Gain',            group: 'Fitness' },
    { label: 'Athletic Performance',   group: 'Fitness' },
    { label: 'Lose Weight',            group: 'Fitness' },
    { label: 'Skin & Hair Health',     group: 'Wellness' },
    { label: 'Hormonal Balance',       group: 'Wellness' },
    { label: 'Bone & Joint Health',    group: 'Wellness' },
    { label: 'Physical Recovery',       group: 'Wellness' },
  ];

  const childGoals = [
    'Boost Immunity', 'Increase Energy', 'Improve Sleep',
    'Digestive Health', 'Bone & Joint Health',
  ];

  const goals = isChild ? childGoals.map(l => ({ label: l, group: '' })) : adultGoals;

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
        {groups.map((group) => {
          const groupGoals = goals.filter(g => g.group === group || group === '');
          return (
            <div key={group} className="goal-group">
              {group && <p className="goal-group-label">{group}</p>}
              <div className="checkbox-grid-2">
                {groupGoals.map(({ label }) => (
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared symptom/severity constants (used by Step3Combined) ─────────────

// Per-symptom severity descriptions — shown when a severity button is selected
const SEVERITY_DESCRIPTIONS = {
  Fatigue: {
    Mild:     'Slightly tired by end of day but can manage daily tasks.',
    Moderate: 'Noticeable tiredness that slows you down during the day.',
    Severe:   'Exhausted most of the time, hard to get out of bed or function.',
  },
  'Digestive Issue': {
    Mild:     'Occasional discomfort or bloating after meals.',
    Moderate: 'Frequent stomach pain, bloating, or irregular bowel movements.',
    Severe:   'Daily digestive pain that disrupts eating and daily activities.',
  },
  'Frequent Colds': {
    Mild:     'Getting sick once or twice a year, recovers quickly.',
    Moderate: 'Gets sick 3–4 times a year, takes longer to recover.',
    Severe:   'Constantly catching colds, rarely feels fully well.',
  },
  'Brain Fog': {
    Mild:     'Occasional difficulty concentrating or mild forgetfulness.',
    Moderate: 'Regularly struggles to focus, forgets things mid-task.',
    Severe:   'Often forgetful, cannot concentrate, feels mentally cloudy most of the day.',
  },
  'Anxiety/Stress': {
    Mild:     'Feels stressed occasionally but can manage it.',
    Moderate: 'Frequent worry or tension that affects sleep or focus.',
    Severe:   'Persistent anxiety that interferes with daily life and relationships.',
  },
  'Joint Pain': {
    Mild:     'Mild stiffness or aching, especially in the morning.',
    Moderate: 'Regular joint pain that limits some physical activities.',
    Severe:   'Constant joint pain that makes movement difficult.',
  },
  'Hair Loss': {
    Mild:     'Slightly more hair than usual in the shower or brush.',
    Moderate: 'Noticeable thinning or patches of hair loss.',
    Severe:   'Significant hair loss visible to others, affecting confidence.',
  },
  'Muscle Weakness': {
    Mild:     'Muscles tire a little faster than expected during activity.',
    Moderate: 'Noticeable weakness when lifting or climbing stairs.',
    Severe:   'Difficulty performing basic tasks like carrying groceries or standing long.',
  },
  'Dry Skin': {
    Mild:     'Skin feels slightly dry or tight, especially after washing.',
    Moderate: 'Persistent dryness with flaking or itching in some areas.',
    Severe:   'Severely dry, cracked, or irritated skin that causes discomfort.',
  },
  'Acne/Skin Issues': {
    Mild:     'Occasional pimples or minor breakouts.',
    Moderate: 'Regular breakouts that are hard to control.',
    Severe:   'Persistent, painful acne covering large areas of the face or body.',
  },
  'Frequent Headaches': {
    Mild:     'Occasional mild headaches, usually relieved by rest or water.',
    Moderate: 'Headaches several times a week that affect concentration.',
    Severe:   'Daily or near-daily headaches that are debilitating.',
  },
  'Numbness/Tingling': {
    Mild:     'Occasional pins-and-needles in hands or feet.',
    Moderate: 'Regular numbness or tingling that comes and goes.',
    Severe:   'Persistent numbness or tingling that affects grip or movement.',
  },
  'Slow Recovery': {
    Mild:     'Takes a day or two longer than expected to recover after exercise.',
    Moderate: 'Muscles stay sore for several days, feels run-down after activity.',
    Severe:   'Barely recovers between workouts or illnesses, always feeling depleted.',
  },
  Bloating: {
    Mild:     'Occasional bloating after certain foods.',
    Moderate: 'Bloating most days, feels uncomfortable after meals.',
    Severe:   'Severe, painful bloating that makes it hard to eat normally.',
  },
  'Low Appetite': {
    Mild:     'Slightly less hungry than usual, skips a meal occasionally.',
    Moderate: 'Regularly not hungry, eating less than needed.',
    Severe:   'Rarely feels hungry, significant reduction in food intake.',
  },
  'Irregular Periods': {
    Mild:     'Cycle is slightly irregular (a few days off) occasionally.',
    Moderate: 'Periods are frequently late, early, or skipped.',
    Severe:   'Very unpredictable cycle or periods missing for months.',
  },
  'Low Libido': {
    Mild:     'Slightly reduced interest in intimacy compared to before.',
    Moderate: 'Noticeably lower drive that affects relationships.',
    Severe:   'Little to no interest in intimacy, causing personal concern.',
  },
};

// Symptom list — removed "Mood Swings" (psychological) and "Low Libido"
// Gender-specific symptoms are filtered in the component
const ALL_SYMPTOMS = [
  { name: 'Fatigue',             genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Digestive Issue',     genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Frequent Colds',      genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Brain Fog',           genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Anxiety/Stress',      genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Joint Pain',          genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Hair Loss',           genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Muscle Weakness',     genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Dry Skin',            genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Acne/Skin Issues',    genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Frequent Headaches',  genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Numbness/Tingling',   genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Slow Recovery',       genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Bloating',            genders: ['Male', 'Female', 'Prefer not to say'] },
  { name: 'Low Appetite',        genders: ['Male', 'Female', 'Prefer not to say'] },
  // Female-specific
  { name: 'Irregular Periods',   genders: ['Female'] },
  { name: 'Low Libido',          genders: ['Male', 'Prefer not to say'] },
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
  const allConditions = [
    'Hypertension',              'Asthma',
    'Diabetes',                  'Kidney Disease',
    'High Blood Pressure',       'Liver Disease',
    'Heart Disease',             'Auto Immune Disorder',
    'Thyroid Disease',           'Anemia',
    'PCOS',                      'Osteoporosis',
    'Celiac/Gluten Sensitivity', 'Gout',
    'None',
  ];

  // PCOS only shown for Female or Prefer not to say
  const showPCOS = data.gender === 'Female' || data.gender === 'Prefer not to say';
  const conditions = allConditions.filter(c => c !== 'PCOS' || showPCOS);

  const toggleCondition = (c) => {
    const current = data.medicalConditions || [];
    if (c === 'None') {
      onChange('medicalConditions', current.includes('None') ? [] : ['None']);
      return;
    }
    const filtered = current.filter((x) => x !== 'None');
    onChange('medicalConditions', filtered.includes(c)
      ? filtered.filter((x) => x !== c)
      : [...filtered, c]);
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
    if (!s.genders.includes(gender) && gender !== '') return false;
    if (s.name === 'Low Libido' && isPregnantOrBreastfeeding) return false;
    return true;
  });
  const [severityErrors, setSeverityErrors] = useState([]);

  const toggleSymptom = (s) => {
    if (s === 'No current symptoms') {
      onChange('symptoms', selectedSymptoms.includes('No current symptoms') ? [] : ['No current symptoms']);
      onChange('symptomSeverity', {});
      setSeverityErrors([]);
      return;
    }
    const filtered = selectedSymptoms.filter(x => x !== 'No current symptoms');
    const isChecked = filtered.includes(s);

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
      ? filtered.filter((x) => x !== s)
      : [...filtered, s];
    onChange('symptoms', next);
    if (isChecked) {
      const newSev = { ...symptomSeverity };
      delete newSev[s];
      onChange('symptomSeverity', newSev);
    }
  };

  const setSeverity = (symptom, level) => {
    onChange('symptomSeverity', { ...symptomSeverity, [symptom]: level });
    // Clear the error for this symptom once severity is selected
    setSeverityErrors(prev => prev.filter(s => s !== symptom));
  };

  const noSymptoms = selectedSymptoms.includes('No current symptoms');

  return (
    <div className="step-body">

      {/* ── Medical Information ── */}
      <h3 className="step-section-title">Medical Information</h3>
      <p className="step-hint">Medical Conditions <span className="field-hint">(select all that apply)</span></p>
      <div className="checkbox-grid-2">
        {conditions.map((c) => (
          <label key={c} className="checkbox-label">
            <input
              type="checkbox"
              checked={(data.medicalConditions || []).includes(c)}
              onChange={() => toggleCondition(c)}
            />
            {c}
          </label>
        ))}
      </div>

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

      {/* ── Current Symptoms ── */}
      <h3 className="step-section-title">Current Symptoms</h3>
      <p className="step-hint">Select any symptoms you're currently experiencing</p>

      <label className="checkbox-label no-symptoms-label">
        <input type="checkbox" checked={noSymptoms}
          onChange={() => toggleSymptom('No current symptoms')} />
        No current symptoms
      </label>

      {!noSymptoms && (
        <div className="symptoms-list">
          {visibleSymptoms.map(({ name: s }) => {
            const checked = selectedSymptoms.includes(s);
            const activeSeverity = symptomSeverity[s];
            const missingSeverity = checked && !activeSeverity && severityErrors.includes(s);
            return (
              <div
                key={s}
                ref={el => { symptomRowRefs.current[s] = el; }}
                className={`symptom-row ${checked ? 'symptom-row-active' : ''} ${missingSeverity ? 'symptom-row-error' : ''}`}
              >
                <label className="checkbox-label">
                  <input type="checkbox" checked={checked}
                    onChange={() => toggleSymptom(s)} />
                  <span className="symptom-name">{s}</span>
                </label>
                {missingSeverity && (
                  <span className="severity-required-inline">⚠ Please select a severity level to proceed</span>
                )}
                {checked && (
                  <div className="severity-wrap">
                    <div className="severity-group">
                      {SEVERITY_OPTIONS.map((level) => (
                        <button key={level} type="button"
                          className={`severity-btn severity-${level.toLowerCase()} ${activeSeverity === level ? 'severity-active' : ''}`}
                          onClick={() => setSeverity(s, level)}>
                          {level}
                        </button>
                      ))}
                    </div>
                    {activeSeverity && (
                      <p className="severity-desc">
                        <strong>{s} – {activeSeverity}:</strong>{' '}
                        {SEVERITY_DESCRIPTIONS[s]?.[activeSeverity] || ''}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sleep Quality */}
      <div className="step-field" style={{ marginTop: '20px' }}>
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

      {/* Water Intake */}
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

      {/* Fitness Focus */}
      <div className="step-field">
        <label>Primary Fitness Focus <span className="field-hint">(optional)</span></label>
        <div className="checkbox-grid-2">
          {['Muscle Gain', 'Fat Loss', 'Endurance / Cardio', 'Flexibility / Mobility', 'General Fitness', 'Not applicable'].map((opt) => (
            <label key={opt} className="radio-label">
              <input type="radio" name="fitnessFocus" value={opt}
                checked={data.fitnessFocus === opt}
                onChange={() => onChange('fitnessFocus', opt)} />
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
  fitnessFocus: '',
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

    const payload = { ...formData, weight: normalizedWeight };

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
