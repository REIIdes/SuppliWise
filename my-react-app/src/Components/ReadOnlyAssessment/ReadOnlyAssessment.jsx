import './ReadOnlyAssessment.css';

/* ── Helpers ──────────────────────────────────────────────────────── */
function Field({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="card-field">
      <label>{label}</label>
      <div className="field-value">
        {Array.isArray(value) ? value.join(', ') : String(value)}
      </div>
    </div>
  );
}

function SeverityBadge({ severity }) {
  if (!severity) return null;
  const cls =
    severity === 'Mild'     ? 'severity-badge--mild'
    : severity === 'Moderate' ? 'severity-badge--moderate'
    : severity === 'Severe'   ? 'severity-badge--severe'
    : 'severity-badge--default';
  return <span className={`severity-badge ${cls}`}>{severity}</span>;
}

function StepHeading({ children }) {
  return (
    <>
      <p className="ro-step-heading">{children}</p>
      <div className="ro-divider" />
    </>
  );
}

/* ── Main component ───────────────────────────────────────────────── */
export default function ReadOnlyAssessment({ assessment, onClose, inline }) {
  if (!assessment) return null;

  const hasValues = (arr) =>
    Array.isArray(arr) && arr.length > 0 && !arr.every(i => i === 'None');

  const filterNone = (arr) => {
    if (!Array.isArray(arr)) return arr;
    const f = arr.filter(i => i !== 'None');
    return f.length > 0 ? f : null;
  };

  const medicalConditions = filterNone(assessment.medicalConditions) || [];
  const noSymptomsFor     = assessment.noSymptomsForConditions || [];
  const symptomSeverity   = assessment.symptomSeverity || {};
  const symptoms          = assessment.symptoms || [];

  const generalSymptoms = symptoms
    .filter(s => s.startsWith('General::'))
    .map(s => s.replace('General::', ''));

  return (
    <div className={`ro-box${inline ? ' ro-box--inline' : ''}`} onClick={e => e.stopPropagation()}>

      {/* ── Header ─────────────────────────────────── */}
      <div className="ro-header">
        <h3>Assessment Information</h3>
        {onClose && (
          <button className="ro-close" onClick={onClose} aria-label="Close">✕</button>
        )}
      </div>

      {/* ── Body ───────────────────────────────────── */}
      <div className="step-body">

        {/* Step 1 */}
        <StepHeading>Step 1 — Basic Information</StepHeading>
        <div className="info-cards-row">
          <div className="info-card">
            <div className="card-header"><h4 className="card-title">Demographics</h4></div>
            <Field label="Age"            value={assessment.age} />
            <Field label="Gender"         value={assessment.gender} />
            <Field label="Weight"         value={assessment.weight   ? `${assessment.weight} kg`  : null} />
            <Field label="Height"         value={assessment.height   ? `${assessment.height} cm`  : null} />
            <Field label="Activity Level" value={assessment.activityLevel} />
          </div>
        </div>

        {/* Step 2 */}
        <StepHeading>Step 2 — Diet &amp; Health Goals</StepHeading>
        <div className="info-cards-row">
          <div className="info-card">
            <Field label="Diet Type"    value={assessment.dietType} />
            <Field label="Health Goals" value={hasValues(assessment.healthGoals) ? filterNone(assessment.healthGoals) : 'None'} />
          </div>
        </div>

        {/* Step 3 */}
        <StepHeading>Step 3 — Current Symptoms</StepHeading>

        {/* General symptoms */}
        {generalSymptoms.length > 0 && (
          <div className="info-cards-row">
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">General Symptoms</h4></div>
              {generalSymptoms.map(symptom => (
                <div key={symptom} className="card-field">
                  <label>{symptom}</label>
                  <div className="field-value">
                    <SeverityBadge severity={symptomSeverity[`General::${symptom}`]} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Condition-specific symptoms */}
        {medicalConditions.length > 0 && medicalConditions.map(condition => {
          const condSymptoms = symptoms
            .filter(s => s.startsWith(`${condition}::`))
            .map(s => s.replace(`${condition}::`, ''));
          const hasNone = noSymptomsFor.includes(condition);
          if (condSymptoms.length === 0 && !hasNone) return null;
          return (
            <div key={condition} className="info-cards-row">
              <div className="info-card">
                <div className="card-header">
                  <h4 className="card-title">Symptoms — {condition}</h4>
                </div>
                {hasNone ? (
                  <p className="ro-empty-note">No symptoms reported for {condition}.</p>
                ) : condSymptoms.map(symptom => (
                  <div key={symptom} className="card-field">
                    <label>{symptom}</label>
                    <div className="field-value">
                      <SeverityBadge severity={symptomSeverity[`${condition}::${symptom}`]} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* No symptoms at all */}
        {symptoms.includes('No current symptoms') && (
          <div className="info-cards-row">
            <div className="info-card">
              <p className="ro-empty-note">No current symptoms reported.</p>
            </div>
          </div>
        )}

        {/* Additional Step 3 fields */}
        <div className="info-cards-row">
          <div className="info-card">
            <div className="card-header"><h4 className="card-title">Additional Information</h4></div>
            <Field label="Stress Level"  value={assessment.stressLevel} />
            <Field label="Sleep Quality" value={assessment.sleepQuality} />
            <Field label="Water Intake"  value={assessment.waterIntake} />
          </div>
        </div>

        {/* Step 4 */}
        <StepHeading>Step 4 — Medical &amp; Lifestyle</StepHeading>
        <div className="info-cards-row">
          <div className="info-card">
            <div className="card-header"><h4 className="card-title">Medical Information</h4></div>
            <Field label="Conditions"   value={hasValues(assessment.medicalConditions) ? filterNone(assessment.medicalConditions) : 'None'} />
            <Field label="Medications"  value={assessment.currentMedications || 'None'} />
            <Field label="Allergies"    value={assessment.allergies || 'None'} />
            {assessment.isPregnant      === 'Yes' && <Field label="Pregnant"     value="Yes" />}
            {assessment.isBreastfeeding === 'Yes' && <Field label="Breastfeeding" value="Yes" />}
          </div>
        </div>

        <div className="info-cards-row">
          <div className="info-card">
            <div className="card-header"><h4 className="card-title">Lifestyle Information</h4></div>
            <Field label="Habits"       value={hasValues(assessment.lifestyleHabits) ? filterNone(assessment.lifestyleHabits) : 'None'} />
            {assessment.recreationalDrugTypes && <Field label="Recreational Drugs" value={assessment.recreationalDrugTypes} />}
            <Field label="Sun Exposure" value={assessment.sunExposure} />
            <Field label="Protein Intake" value={assessment.proteinIntake} />
          </div>
        </div>

        <div className="info-cards-row">
          <div className="info-card">
            <div className="card-header"><h4 className="card-title">Supplements &amp; Tests</h4></div>
            <Field label="Taking Supplements" value={assessment.takingSupplements || 'No'} />
            {assessment.takingSupplements === 'Yes' &&
              <Field label="Current Supplements" value={assessment.currentSupplements || 'None specified'} />}
            <Field label="Recent Blood Test" value={assessment.recentBloodTest || 'No'} />
            {assessment.recentBloodTest === 'Yes' && assessment.bloodTestResults &&
              <Field label="Blood Test Results" value={assessment.bloodTestResults} />}
          </div>
        </div>

      </div>
    </div>
  );
}
