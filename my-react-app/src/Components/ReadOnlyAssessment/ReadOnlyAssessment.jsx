import React from 'react';
import './ReadOnlyAssessment.css';

function Field({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="card-field">
      <label>{label}</label>
      <div className="field-value">{Array.isArray(value) ? value.join(', ') : String(value)}</div>
    </div>
  );
}

export default function ReadOnlyAssessment({ assessment, onClose, inline = false }) {
  if (!assessment) return null;

  const Box = (
    <div className="ro-box" onClick={e => e.stopPropagation()}>
      <div className="ro-header">
        <h3>Assessment Answers</h3>
        {onClose && <button className="ro-close" onClick={onClose}>✕</button>}
      </div>

      <div className="step-body">
          <div className="section-header-with-icon">
            <h3 className="section-title">Basic Information</h3>
          </div>
          <div className="section-divider"></div>
          <div className="info-cards-row">
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">Demographics</h4></div>
              <Field label="Age" value={assessment.age} />
              <Field label="Gender" value={assessment.gender} />
              <Field label="Weight (kg)" value={assessment.weight} />
              <Field label="Height (cm)" value={assessment.height} />
              <Field label="Activity Level" value={assessment.activityLevel} />
              <Field label="Diet Type" value={assessment.dietType} />
            </div>
          </div>

          <div className="section-header-with-icon" style={{ marginTop: 12 }}>
            <h3 className="section-title">Health Goals & Symptoms</h3>
          </div>
          <div className="section-divider"></div>
          <div className="info-cards-row">
            <div className="info-card">
              <Field label="Health Goals" value={assessment.healthGoals} />
              <Field label="Symptoms" value={assessment.symptoms} />
            </div>
          </div>

          <div className="section-header-with-icon" style={{ marginTop: 12 }}>
            <h3 className="section-title">Medical & Lifestyle</h3>
          </div>
          <div className="section-divider"></div>
          <div className="info-cards-row">
            <div className="info-card">
              <Field label="Medical Conditions" value={assessment.medicalConditions} />
              <Field label="Current Medications" value={assessment.currentMedications} />
              <Field label="Allergies" value={assessment.allergies} />
              <Field label="Lifestyle Habits" value={assessment.lifestyleHabits} />
              <Field label="Taking Supplements" value={assessment.takingSupplements} />
              <Field label="Current Supplements" value={assessment.currentSupplements} />
            </div>
          </div>

      </div>
    </div>
  );

  if (inline) {
    return (
      <div className="ro-box-inline">
        {Box}
      </div>
    );
  }

  return (
    <div className="ro-overlay" onClick={onClose}>
      {Box}
    </div>
  );
}
