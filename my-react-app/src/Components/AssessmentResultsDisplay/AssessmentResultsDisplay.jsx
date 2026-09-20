import React from 'react';
import './AssessmentResultsDisplay.css';

/* ── Helpers ──────────────────────────────────────────────────────── */
function ArdField({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="ard-field">
      <span className="ard-field__label">{label}</span>
      <span className="ard-field__value">{String(value)}</span>
    </div>
  );
}

function PriorityBadge({ priority }) {
  if (!priority) return null;
  const p = priority.toLowerCase();
  const cls =
    p === 'high'   ? 'ard-priority--high'
    : p === 'medium' ? 'ard-priority--medium'
    : p === 'low'    ? 'ard-priority--low'
    : 'ard-priority--default';
  const dot =
    p === 'high' ? '🔴' : p === 'medium' ? '🟠' : p === 'low' ? '🟢' : '⚪';
  return (
    <span className={`ard-priority ${cls}`}>
      {dot} {priority}
    </span>
  );
}

function ConfidenceBar({ score }) {
  if (score === null || score === undefined) return null;
  const pct = Math.min(100, Math.max(0, Number(score)));
  return (
    <div className="ard-confidence">
      <span className="ard-confidence__label">Confidence</span>
      <div className="ard-confidence__track">
        <div className="ard-confidence__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ard-confidence__pct">{pct}%</span>
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────────── */
const AssessmentResultsDisplay = ({ results }) => {
  if (!results) {
    return <p className="ard-empty">No results available.</p>;
  }

  const { summary, consultDoctor, consultReason, recommendations } = results;

  return (
    <div className="ard-wrap">

      {/* ── Summary ──────────────────────────────── */}
      <p className="ard-section-title">Summary</p>
      <div className="ard-divider" />

      <div className="ard-summary">
        <p>{summary}</p>
        {consultDoctor && (
          <div className="ard-consult">
            <span className="ard-consult__icon" aria-hidden="true">⚠️</span>
            <div className="ard-consult__body">
              <p className="ard-consult__title">Consult a Doctor Recommended</p>
              <p className="ard-consult__reason">{consultReason}</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Recommendations ──────────────────────── */}
      <p className="ard-section-title">Recommendations</p>
      <div className="ard-divider" />

      {recommendations && recommendations.length > 0 ? (
        <div className="ard-rec-list">
          {recommendations.map((rec, index) => (
            <div key={index} className="ard-card">

              {/* Card top bar: name + priority */}
              <div className="ard-card__bar">
                <h4 className="ard-card__name">{rec.name}</h4>
                <PriorityBadge priority={rec.priority} />
              </div>

              {/* Card body: fields */}
              <div className="ard-card__body">
                <ArdField label="Reason"       value={rec.reason} />
                <ArdField label="Dosage"       value={rec.dosage} />
                <ArdField label="Timing"       value={rec.timing} />
                <ArdField label="Interactions" value={rec.interactions} />
                <ArdField label="Foods"        value={rec.foods} />
                <ArdField label="Side Effects" value={rec.sideEffects} />
                <ArdField label="Evidence"     value={rec.evidence} />
                <ConfidenceBar score={rec.confidenceScore} />
              </div>

            </div>
          ))}
        </div>
      ) : (
        <p className="ard-empty">No recommendations were generated.</p>
      )}

    </div>
  );
};

export default AssessmentResultsDisplay;
