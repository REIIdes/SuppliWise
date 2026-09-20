import React from 'react';
import './AssessmentResultsDisplay.css';

const AssessmentResultsDisplay = ({ results }) => {
  if (!results) {
    return <p>No results available.</p>;
  }

  const { summary, consultDoctor, consultReason, recommendations } = results;

  return (
    <div className="assessment-results-display">
      <div className="results-summary section">
        <h3>Summary</h3>
        <p>{summary}</p>
        {consultDoctor && (
          <div className="consult-doctor-alert">
            <h4>Consult Doctor Recommended</h4>
            <p>{consultReason}</p>
          </div>
        )}
      </div>
      <div className="results-recommendations section">
        <h3>Recommendations</h3>
        {recommendations && recommendations.length > 0 ? (
          recommendations.map((rec, index) => (
            <div key={index} className="recommendation-card">
              <h4>{rec.name}</h4>
              <div className="recommendation-details">
                <p><strong>Reason:</strong> {rec.reason}</p>
                <p><strong>Dosage:</strong> {rec.dosage}</p>
                <p><strong>Timing:</strong> {rec.timing}</p>
                <p><strong>Priority:</strong> <span className={`priority-${rec.priority?.toLowerCase()}`}>{rec.priority}</span></p>
                <p><strong>Interactions:</strong> {rec.interactions}</p>
                <p><strong>Foods:</strong> {rec.foods}</p>
                <p><strong>Side Effects:</strong> {rec.sideEffects}</p>
                <p><strong>Evidence:</strong> {rec.evidence}</p>
                <p><strong>Confidence:</strong> {rec.confidenceScore}%</p>
              </div>
            </div>
          ))
        ) : (
          <p>No recommendations were generated.</p>
        )}
      </div>
    </div>
  );
};

export default AssessmentResultsDisplay;