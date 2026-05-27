import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { saveAssessment, getRecommendations, saveAssessmentResults } from '../api';
import './AssessmentPage.css';

const TOTAL_STEPS = 4;
const SESSION_KEY = 'pending_assessment';

// ── Validation helpers ─────────────────────────────────────────────────────
const LIMITS = {
  age:    { min: 1,   max: 120 },
  weight: { min: 1,   max: 500 },
  height: { min: 30,  max: 300 },
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
  // Reject if >80% same character, or all spaces/symbols
  if (/^(.)\1{4,}$/.test(t)) return true;
  if (/^[^a-zA-Z0-9]+$/.test(t)) return true;
  return false;
}

// ── Step 1: Basic Information ──────────────────────────────────────────────
function Step1({ data, onChange, errors }) {
  const age = Number(data.age) || 0;
  const showActivityLevel = age === 0 || age >= 13;

  const activityOptions = [
    { value: 'Sedentary', label: 'Sedentary / No Exercise' },
    { value: 'Light',     label: 'Light (1–3 days/week)' },
    { value: 'Moderate',  label: 'Moderate (3–5 days/week)' },
    { value: 'Very',      label: 'Very Active (6–7 days/week)' },
  ];

  const handleNumeric = (field, value) => onChange(field, value);
  const handleBlur = (field, value) => {
    const { min, max } = LIMITS[field];
    onChange(field, clamp(value, min, max));
  };

  return (
    <div className="step-body">
      <h3 className="step-section-title">Basic Information</h3>

      <div className="step-row">
        <div className={`step-field ${errors.age ? 'field-error' : ''}`}>
          <label>Age <span className="required-star">*</span> <span className="field-hint">(1–120)</span></label>
          <input
            type="number"
            placeholder="Enter your age"
            value={data.age}
            min={1} max={120}
            onChange={(e) => handleNumeric('age', e.target.value)}
            onBlur={(e) => handleBlur('age', e.target.value)}
          />
          {errors.age && <span className="field-error-msg">{errors.age}</span>}
        </div>
        <div className={`step-field ${errors.gender ? 'field-error' : ''}`}>
          <label>Gender <span className="required-star">*</span></label>
          <div className="radio-group">
            {['Male', 'Female', 'Other'].map((g) => (
              <label key={g} className="radio-label">
                <input
                  type="radio"
                  name="gender"
                  value={g}
                  checked={data.gender === g}
                  onChange={() => onChange('gender', g)}
                />
                {g}
              </label>
            ))}
          </div>
          {errors.gender && <span className="field-error-msg">{errors.gender}</span>}
        </div>
      </div>

      <div className="step-row">
        <div className={`step-field ${errors.weight ? 'field-error' : ''}`}>
          <label>Weight (kg) <span className="required-star">*</span> <span className="field-hint">(1–500)</span></label>
          <input
            type="number"
            placeholder="e.g. 70"
            value={data.weight}
            min={1} max={500}
            onChange={(e) => handleNumeric('weight', e.target.value)}
            onBlur={(e) => handleBlur('weight', e.target.value)}
          />
          {errors.weight && <span className="field-error-msg">{errors.weight}</span>}
        </div>
        <div className={`step-field ${errors.height ? 'field-error' : ''}`}>
          <label>Height (cm) <span className="required-star">*</span> <span className="field-hint">(30–300)</span></label>
          <input
            type="number"
            placeholder="e.g. 170"
            value={data.height}
            min={30} max={300}
            onChange={(e) => handleNumeric('height', e.target.value)}
            onBlur={(e) => handleBlur('height', e.target.value)}
          />
          {errors.height && <span className="field-error-msg">{errors.height}</span>}
        </div>
      </div>

      {showActivityLevel && (
        <div className="step-field">
          <label>Activity Level</label>
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
  const diets = ['Omnivore', 'Keto', 'Vegan', 'Paleo', 'Vegetarian'];
  const goals = isChild
    ? ['Boost Immunity', 'Increase Energy', 'Improve Sleep', 'Digestive Health', 'Bone Management']
    : [
        'Increase Energy',        'Enhance Mental Clarity',
        'Improve Sleep',          'Weight Management',
        'Boost Immunity',         'Bone Management',
        'Support Heart Health',   'Digestive Health',
        'Muscle Gain',            'Skin & Hair Health',
        'Hormonal Balance',       'Athletic Performance',
        'Anti-Aging',             'Stress Management',
      ];

  const toggleGoal = (goal) => {
    const current = data.healthGoals || [];
    onChange('healthGoals', current.includes(goal)
      ? current.filter((g) => g !== goal)
      : [...current, goal]);
  };

  return (
    <div className="step-body">
      <h3 className="step-section-title">Diet &amp; Health Goals</h3>
      <div className="step-field">
        <label>Diet Type</label>
        <div className="checkbox-grid-2">
          {diets.map((d) => (
            <label key={d} className="checkbox-label">
              <input type="radio" name="dietType" value={d}
                checked={data.dietType === d}
                onChange={() => onChange('dietType', d)} />
              {d}
            </label>
          ))}
        </div>
      </div>
      <div className="step-field" style={{ marginTop: '24px' }}>
        <label>Health Goals <span className="field-hint">(select all that apply)</span></label>
        <div className="checkbox-grid-2">
          {goals.map((g) => (
            <label key={g} className="checkbox-label">
              <input type="checkbox"
                checked={(data.healthGoals || []).includes(g)}
                onChange={() => toggleGoal(g)} />
              {g}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Current Symptoms ───────────────────────────────────────────────
const SYMPTOM_LIST = [
  'Fatigue',            'Digestive Issue',
  'Frequent Colds',     'Brain Fog',
  'Anxiety/Stress',     'Joint Pain',
  'Hair Loss',          'Muscle Weakness',
  'Dry Skin',           'Acne/Skin Issues',
  'Frequent Headaches', 'Mood Swings',
  'Low Libido',         'Numbness/Tingling',
  'Slow Recovery',      'Bloating',
  'Low Appetite',
];

const SEVERITY_OPTIONS = ['Mild', 'Moderate', 'Severe'];

function Step3({ data, onChange }) {
  const selectedSymptoms = data.symptoms || [];
  const symptomSeverity = data.symptomSeverity || {};

  const toggleSymptom = (s) => {
    if (s === 'No current symptoms') {
      onChange('symptoms', selectedSymptoms.includes('No current symptoms') ? [] : ['No current symptoms']);
      onChange('symptomSeverity', {});
      return;
    }
    const filtered = selectedSymptoms.filter(x => x !== 'No current symptoms');
    const next = filtered.includes(s)
      ? filtered.filter((x) => x !== s)
      : [...filtered, s];
    onChange('symptoms', next);
    // Remove severity if symptom deselected
    if (filtered.includes(s)) {
      const newSev = { ...symptomSeverity };
      delete newSev[s];
      onChange('symptomSeverity', newSev);
    }
  };

  const setSeverity = (symptom, level) => {
    onChange('symptomSeverity', { ...symptomSeverity, [symptom]: level });
  };

  const noSymptoms = selectedSymptoms.includes('No current symptoms');

  return (
    <div className="step-body">
      <h3 className="step-section-title">Current Symptoms</h3>
      <p className="step-hint">Select any symptoms you're currently experiencing</p>

      {/* No symptoms option */}
      <label className="checkbox-label no-symptoms-label">
        <input type="checkbox"
          checked={noSymptoms}
          onChange={() => toggleSymptom('No current symptoms')} />
        No current symptoms
      </label>

      {!noSymptoms && (
        <div className="symptoms-list">
          {SYMPTOM_LIST.map((s) => {
            const checked = selectedSymptoms.includes(s);
            return (
              <div key={s} className={`symptom-row ${checked ? 'symptom-row-active' : ''}`}>
                <label className="checkbox-label">
                  <input type="checkbox"
                    checked={checked}
                    onChange={() => toggleSymptom(s)} />
                  {s}
                </label>
                {checked && (
                  <div className="severity-group">
                    {SEVERITY_OPTIONS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={`severity-btn severity-${level.toLowerCase()} ${symptomSeverity[s] === level ? 'severity-active' : ''}`}
                        onClick={() => setSeverity(s, level)}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sleep Quality */}
      <div className="step-field">
        <label>Sleep Quality</label>
        <div className="radio-group flex-wrap">
          {['Very Poor', 'Poor', 'Average', 'Good', 'Excellent'].map((q) => (
            <label key={q} className="radio-label">
              <input
                type="radio"
                name="sleepQuality"
                value={q}
                checked={data.sleepQuality === q}
                onChange={() => onChange('sleepQuality', q)}
              />
              {q}
            </label>
          ))}
        </div>
      </div>

      {/* Water Intake */}
      <div className="step-field">
        <label>Daily Water Intake <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['<1L', '1–2L', '2–3L', '3L+'].map((w) => (
            <label key={w} className="radio-label">
              <input
                type="radio"
                name="waterIntake"
                value={w}
                checked={data.waterIntake === w}
                onChange={() => onChange('waterIntake', w)}
              />
              {w}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 4: Medical Information ────────────────────────────────────────────
function Step4({ data, onChange, errors }) {
  const conditions = [
    'Diabetes',             'Kidney Disease',
    'High Blood Pressure',  'Liver Disease',
    'Heart Disease',        'Auto Immune Disorder',
    'Thyroid Disease',      'Anemia',
    'PCOS',                 'Osteoporosis',
    'Depression/Anxiety',   'Celiac/Gluten Sensitivity',
    'Gout',                 'None',
  ];

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
      <h3 className="step-section-title">Medical Information</h3>
      <p className="step-hint">Medical Conditions (select all that apply)</p>
      <div className="checkbox-grid-2">
        {conditions.map((c) => (
          <label key={c} className="checkbox-label">
            <input type="checkbox"
              checked={(data.medicalConditions || []).includes(c)}
              onChange={() => toggleCondition(c)} />
            {c}
          </label>
        ))}
      </div>

      {/* Pregnancy / Breastfeeding */}
      {(data.gender === 'Female' || data.gender === 'Other') && (
        <div className="step-field" style={{ marginTop: '20px' }}>
          <label>Pregnancy / Breastfeeding</label>
          <div className="radio-group flex-wrap">
            {['Not applicable', 'Pregnant', 'Breastfeeding', 'Planning to conceive'].map((opt) => (
              <label key={opt} className="radio-label">
                <input
                  type="radio"
                  name="pregnancyStatus"
                  value={opt}
                  checked={data.pregnancyStatus === opt}
                  onChange={() => onChange('pregnancyStatus', opt)}
                />
                {opt}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Lifestyle Habits */}
      <div className="step-field" style={{ marginTop: '20px' }}>
        <label>Lifestyle Habits <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['Smoking', 'Alcohol', 'None'].map((habit) => (
            <label key={habit} className="checkbox-label">
              <input
                type="checkbox"
                checked={(data.lifestyleHabits || []).includes(habit)}
                onChange={() => toggleLifestyle(habit)}
              />
              {habit}
            </label>
          ))}
        </div>
      </div>

      {/* Current Supplement Usage */}
      <div className="step-field" style={{ marginTop: '8px' }}>
        <label>Are you currently taking any supplements?</label>
        <div className="radio-group">
          {['Yes', 'No'].map((opt) => (
            <label key={opt} className="radio-label">
              <input
                type="radio"
                name="takingSupplements"
                value={opt}
                checked={data.takingSupplements === opt}
                onChange={() => onChange('takingSupplements', opt)}
              />
              {opt}
            </label>
          ))}
        </div>
        {data.takingSupplements === 'Yes' && (
          <textarea
            placeholder="List the supplements you're currently taking (e.g. Vitamin D 2000 IU, Fish Oil 1g)"
            value={data.currentSupplements || ''}
            onChange={(e) => onChange('currentSupplements', e.target.value)}
            rows={2}
            style={{ marginTop: '8px' }}
          />
        )}
      </div>

      {/* Recent Blood Test */}
      <div className="step-field">
        <label>Have you had a recent blood test?</label>
        <div className="radio-group">
          {['Yes', 'No'].map((opt) => (
            <label key={opt} className="radio-label">
              <input
                type="radio"
                name="recentBloodTest"
                value={opt}
                checked={data.recentBloodTest === opt}
                onChange={() => onChange('recentBloodTest', opt)}
              />
              {opt}
            </label>
          ))}
        </div>
        {data.recentBloodTest === 'Yes' && (
          <textarea
            placeholder="Share what your results showed — e.g. 'Low vitamin D (18 ng/mL), low ferritin (12), normal B12' — the more detail, the more targeted your recommendations will be."
            value={data.bloodTestResults || ''}
            onChange={(e) => onChange('bloodTestResults', e.target.value)}
            rows={3}
            style={{ marginTop: '8px', resize: 'vertical' }}
          />
        )}
      </div>

      <div className="step-row" style={{ marginTop: '8px' }}>
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
          <label>Current Allergies <span className="field-hint">(optional)</span></label>
          <textarea
            placeholder="List any allergies (food, medication, etc.)"
            value={data.allergies || ''}
            onChange={(e) => onChange('allergies', e.target.value)}
            rows={3} />
          {errors.allergies && <span className="field-error-msg">{errors.allergies}</span>}
        </div>
      </div>

      {/* Sun Exposure */}
      <div className="step-field" style={{ marginTop: '8px' }}>
        <label>Daily Sun Exposure <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['< 15 min', '15–30 min', '30–60 min', '1 hr+'].map((opt) => (
            <label key={opt} className="radio-label">
              <input
                type="radio"
                name="sunExposure"
                value={opt}
                checked={data.sunExposure === opt}
                onChange={() => onChange('sunExposure', opt)}
              />
              {opt}
            </label>
          ))}
        </div>
      </div>

      {/* Fitness Focus */}
      <div className="step-field" style={{ marginTop: '8px' }}>
        <label>Primary Fitness Focus <span className="field-hint">(optional)</span></label>
        <div className="checkbox-grid-2">
          {['Muscle Gain', 'Fat Loss', 'Endurance / Cardio', 'Flexibility / Mobility', 'General Fitness', 'Not applicable'].map((opt) => (
            <label key={opt} className="radio-label">
              <input
                type="radio"
                name="fitnessFocus"
                value={opt}
                checked={data.fitnessFocus === opt}
                onChange={() => onChange('fitnessFocus', opt)}
              />
              {opt}
            </label>
          ))}
        </div>
      </div>

      {/* Protein Intake */}
      <div className="step-field" style={{ marginTop: '8px' }}>
        <label>Daily Protein Intake <span className="field-hint">(optional)</span></label>
        <div className="radio-group flex-wrap">
          {['Very Low (< 50g)', 'Low (50–80g)', 'Moderate (80–120g)', 'High (120g+)', 'Not sure'].map((opt) => (
            <label key={opt} className="radio-label">
              <input
                type="radio"
                name="proteinIntake"
                value={opt}
                checked={data.proteinIntake === opt}
                onChange={() => onChange('proteinIntake', opt)}
              />
              {opt}
            </label>
          ))}
        </div>
      </div>

      <div className="step-field" style={{ marginTop: '8px' }}>
        <label>
          Describe Your Current Health Concerns <span className="field-hint">(optional)</span>
        </label>
        <textarea
          placeholder="Describe how you've been feeling lately in your own words — e.g. 'I've been feeling exhausted even after 8 hours of sleep, my joints ache in the morning, and I feel foggy at work...'"
          value={data.feelingDescription || ''}
          onChange={(e) => onChange('feelingDescription', e.target.value)}
          rows={4}
          style={{ resize: 'vertical' }}
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
      errors.age = 'Please enter a valid age (1–120).';
    if (!formData.gender)
      errors.gender = 'Please select a gender.';
    if (!formData.weight || Number(formData.weight) < 1 || Number(formData.weight) > 500)
      errors.weight = 'Please enter a valid weight (1–500 kg).';
    if (!formData.height || Number(formData.height) < 30 || Number(formData.height) > 300)
      errors.height = 'Please enter a valid height (30–300 cm).';

    // BMI sanity check
    if (formData.weight && formData.height) {
      const bmi = Number(formData.weight) / ((Number(formData.height) / 100) ** 2);
      if (bmi < 5 || bmi > 80)
        errors.weight = 'The height/weight combination seems impossible. Please check your values.';
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
  age: '', gender: '', weight: '', height: '', activityLevel: '',
  dietType: '', healthGoals: [],
  symptoms: [], symptomSeverity: {},
  stressLevel: '', sleepQuality: '', waterIntake: '',
  medicalConditions: [], currentMedications: '', allergies: '',
  lifestyleHabits: [],
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
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for field on change
    if (errors[field]) setErrors(prev => { const e = { ...prev }; delete e[field]; return e; });
  };

  const handleNext = () => {
    const stepErrors = validateStep(step, formData);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
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

    // Final step validation
    const stepErrors = validateStep(step, formData);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }

    // Prevent empty assessment
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

    setSubmitting(true);
    try {
      // Step 1: Save assessment — retry once on failure so it always records
      let assessmentId = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const saveResult = await saveAssessment(formData);
          assessmentId = saveResult?.assessment?._id;
          if (assessmentId) break;
        } catch (saveErr) {
          console.error(`Assessment save attempt ${attempt} failed:`, saveErr.message);
          if (attempt === 2) {
            // Still don't block the user — log but continue
            console.error('Assessment could not be saved after 2 attempts. Continuing to get recommendations.');
          }
        }
      }

      // Step 2: Get AI recommendations
      const recommendations = await getRecommendations(formData);

      // Step 3: Attach AI results to the saved assessment
      if (assessmentId) {
        try {
          await saveAssessmentResults(assessmentId, recommendations);
        } catch (aiSaveErr) {
          console.error('AI results save error:', aiSaveErr.message);
        }
      }

      sessionStorage.removeItem(SESSION_KEY);
      navigate('/results', { state: { recommendations, assessment: formData } });
    } catch (err) {
      // Show a friendly message — never expose raw server/network errors
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
          {step === 3 && <Step3 data={formData} onChange={handleChange} errors={errors} />}
          {step === 4 && <Step4 data={formData} onChange={handleChange} errors={errors} />}

          <div className="assessment-footer">
            <button className="btn-cancel" onClick={handleBack}>← {step === 1 ? 'Cancel' : 'Back'}</button>
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
