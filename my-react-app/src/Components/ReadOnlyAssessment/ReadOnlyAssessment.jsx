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

  // Helper to check if array has values other than "None"
  const hasValues = (arr) => {
    if (!arr || !Array.isArray(arr) || arr.length === 0) return false;
    return !arr.every(item => item === 'None');
  };

  // Helper to filter out "None" from arrays
  const filterNone = (arr) => {
    if (!arr || !Array.isArray(arr)) return arr;
    const filtered = arr.filter(item => item !== 'None');
    return filtered.length > 0 ? filtered : null;
  };

  const Box = (
    <div className="ro-box" onClick={e => e.stopPropagation()}>
      <div className="ro-header">
        <h3>Assessment Answers</h3>
        {onClose && <button className="ro-close" onClick={onClose}>✕</button>}
      </div>

      <div className="step-body">
          {/* Step 1: Basic Information */}
          <div className="section-header-with-icon">
            <h3 className="section-title">Step 1: Basic Information</h3>
          </div>
          <div className="section-divider"></div>
          <div className="info-cards-row">
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">Demographics</h4></div>
              <Field label="Age" value={assessment.age} />
              <Field label="Gender" value={assessment.gender} />
              <Field label="Weight" value={assessment.weight ? `${assessment.weight} kg` : null} />
              <Field label="Height" value={assessment.height ? `${assessment.height} cm` : null} />
              <Field label="Activity Level" value={assessment.activityLevel} />
            </div>
          </div>

          {/* Step 2: Diet & Health Goals */}
          <div className="section-header-with-icon" style={{ marginTop: 12 }}>
            <h3 className="section-title">Step 2: Diet & Health Goals</h3>
          </div>
          <div className="section-divider"></div>
          <div className="info-cards-row">
            <div className="info-card">
              <Field label="Diet Type" value={assessment.dietType} />
              <Field label="Health Goals" value={hasValues(assessment.healthGoals) ? filterNone(assessment.healthGoals) : 'None'} />
            </div>
          </div>

          {/* Step 3: Symptoms */}
          <div className="section-header-with-icon" style={{ marginTop: 12 }}>
            <h3 className="section-title">Step 3: Current Symptoms</h3>
          </div>
          <div className="section-divider"></div>
          
          {/* General Symptoms */}
          {(() => {
            const generalSymptoms = (assessment.symptoms || [])
              .filter(s => s.startsWith('General::'))
              .map(s => s.replace('General::', ''));
            const symptomSeverity = assessment.symptomSeverity || {};
            
            if (generalSymptoms.length > 0) {
              return (
                <div className="info-cards-row">
                  <div className="info-card">
                    <div className="card-header"><h4 className="card-title">General Symptoms</h4></div>
                    {generalSymptoms.map(symptom => {
                      const severity = symptomSeverity[`General::${symptom}`];
                      return (
                        <div key={symptom} className="card-field">
                          <label>{symptom}</label>
                          <div className="field-value">
                            {severity && <span style={{ 
                              padding: '2px 8px', 
                              borderRadius: '4px', 
                              fontSize: '12px',
                              fontWeight: 600,
                              background: severity === 'Mild' ? '#fef3c7' : severity === 'Moderate' ? '#fed7aa' : '#fecaca',
                              color: severity === 'Mild' ? '#92400e' : severity === 'Moderate' ? '#9a3412' : '#991b1b'
                            }}>
                              {severity}
                            </span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
          })()}
          
          {/* Condition-Specific Symptoms */}
          {(() => {
            const medicalConditions = filterNone(assessment.medicalConditions) || [];
            const noSymptomsFor = assessment.noSymptomsForConditions || [];
            const symptomSeverity = assessment.symptomSeverity || {};
            
            if (Array.isArray(medicalConditions) && medicalConditions.length > 0) {
              return medicalConditions.map(condition => {
                const conditionSymptoms = (assessment.symptoms || [])
                  .filter(s => s.startsWith(condition + '::'))
                  .map(s => s.replace(condition + '::', ''));
                
                const hasNoSymptoms = noSymptomsFor.includes(condition);
                
                if (conditionSymptoms.length === 0 && !hasNoSymptoms) return null;
                
                return (
                  <div key={condition} className="info-cards-row" style={{ marginTop: 8 }}>
                    <div className="info-card">
                      <div className="card-header">
                        <h4 className="card-title">Symptoms for {condition}</h4>
                      </div>
                      {hasNoSymptoms ? (
                        <div className="card-field">
                          <div className="field-value" style={{ fontStyle: 'italic', color: '#6b7280' }}>
                            No symptoms for {condition}
                          </div>
                        </div>
                      ) : (
                        conditionSymptoms.map(symptom => {
                          const severity = symptomSeverity[`${condition}::${symptom}`];
                          return (
                            <div key={symptom} className="card-field">
                              <label>{symptom}</label>
                              <div className="field-value">
                                {severity && <span style={{ 
                                  padding: '2px 8px', 
                                  borderRadius: '4px', 
                                  fontSize: '12px',
                                  fontWeight: 600,
                                  background: severity === 'Mild' ? '#fef3c7' : severity === 'Moderate' ? '#fed7aa' : '#fecaca',
                                  color: severity === 'Mild' ? '#92400e' : severity === 'Moderate' ? '#9a3412' : '#991b1b'
                                }}>
                                  {severity}
                                </span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              });
            }
          })()}
          
          {/* No Symptoms Selected */}
          {(assessment.symptoms || []).includes('No current symptoms') && (
            <div className="info-cards-row">
              <div className="info-card">
                <div className="card-field">
                  <div className="field-value" style={{ fontStyle: 'italic', color: '#6b7280' }}>
                    No current symptoms
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {/* Other Step 3 Fields */}
          <div className="info-cards-row" style={{ marginTop: 8 }}>
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">Additional Information</h4></div>
              <Field label="Stress Level" value={assessment.stressLevel} />
              <Field label="Sleep Quality" value={assessment.sleepQuality} />
              <Field label="Water Intake" value={assessment.waterIntake} />
            </div>
          </div>

          {/* Step 4: Medical & Lifestyle */}
          <div className="section-header-with-icon" style={{ marginTop: 12 }}>
            <h3 className="section-title">Step 4: Medical & Lifestyle Information</h3>
          </div>
          <div className="section-divider"></div>
          <div className="info-cards-row">
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">Medical Information</h4></div>
              <Field label="Medical Conditions" value={hasValues(assessment.medicalConditions) ? filterNone(assessment.medicalConditions) : 'None'} />
              <Field label="Current Medications" value={assessment.currentMedications || 'None'} />
              <Field label="Allergies" value={assessment.allergies || 'None'} />
              {assessment.isPregnant === 'Yes' && <Field label="Pregnant" value="Yes" />}
              {assessment.isBreastfeeding === 'Yes' && <Field label="Breastfeeding" value="Yes" />}
            </div>
          </div>

          <div className="info-cards-row" style={{ marginTop: 8 }}>
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">Lifestyle Information</h4></div>
              <Field label="Lifestyle Habits" value={hasValues(assessment.lifestyleHabits) ? filterNone(assessment.lifestyleHabits) : 'None'} />
              {assessment.recreationalDrugTypes && <Field label="Recreational Drug Types" value={assessment.recreationalDrugTypes} />}
              <Field label="Sun Exposure" value={assessment.sunExposure} />
              <Field label="Protein Intake" value={assessment.proteinIntake} />
            </div>
          </div>

          <div className="info-cards-row" style={{ marginTop: 8 }}>
            <div className="info-card">
              <div className="card-header"><h4 className="card-title">Supplements & Tests</h4></div>
              <Field label="Taking Supplements" value={assessment.takingSupplements || 'No'} />
              {assessment.takingSupplements === 'Yes' && <Field label="Current Supplements" value={assessment.currentSupplements || 'None specified'} />}
              <Field label="Recent Blood Test" value={assessment.recentBloodTest || 'No'} />
              {assessment.recentBloodTest === 'Yes' && assessment.bloodTestResults && <Field label="Blood Test Results" value={assessment.bloodTestResults} />}
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
