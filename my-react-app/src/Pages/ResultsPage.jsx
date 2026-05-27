import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { exportResultsToPDF } from '../utils/exportPDF';
import './ResultsPage.css';

const priorityColor = { High: '#16a34a', Medium: '#d97706', Low: '#6b7280' };
const priorityIcon = { High: '🔴', Medium: '🟡', Low: '🟢' };
const severityColor = { Severe: '#dc2626', Moderate: '#d97706', 'Mild to Moderate': '#f59e0b', Mild: '#22c55e', Preventive: '#6b7280' };

const SUPPLEMENT_ICONS = {
  magnesium: '🧲', 'vitamin d': '☀️', 'vitamin b': '💉', 'b12': '💉',
  omega: '🐟', 'fish oil': '🐟', iron: '🔴', zinc: '🛡️',
  'vitamin c': '🍊', calcium: '🦴', coq10: '❤️', probiotic: '🦠',
  ashwagandha: '🌿', "lion's mane": '🍄', curcumin: '🟡', berberine: '🌱',
  selenium: '⚡', collagen: '💪', creatine: '💪', melatonin: '🌙',
  'vitamin k': '🥦', riboflavin: '🟠', theanine: '🍵', glucosamine: '🦴',
};

function getSupplementIcon(name) {
  const n = (name || '').toLowerCase();
  for (const [key, icon] of Object.entries(SUPPLEMENT_ICONS)) {
    if (n.includes(key)) return icon;
  }
  return '💊';
}

function ConfidenceBar({ score, delay = 0 }) {
  const [width, setWidth] = useState(0);
  const [displayed, setDisplayed] = useState(0);
  const rafRef = useRef(null);

  // Animate the bar fill after mount (with optional stagger delay)
  useEffect(() => {
    const timer = setTimeout(() => setWidth(score), delay);
    return () => clearTimeout(timer);
  }, [score, delay]);

  // Count-up the number in sync with the bar
  useEffect(() => {
    if (width === 0) { setDisplayed(0); return; }
    const duration = 700; // ms — matches CSS transition
    const start = performance.now();
    const from = displayed;

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out curve
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayed(Math.round(from + (score - from) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const color = score >= 85 ? '#22c55e' : score >= 75 ? '#d97706' : '#6b7280';

  return (
    <div className="confidence-bar-wrap">
      <div className="confidence-bar-track">
        <div
          className="confidence-bar-fill"
          style={{ width: `${width}%`, background: color }}
        />
      </div>
      <span className="confidence-label" style={{ color }}>{displayed}% match</span>
    </div>
  );
}

function SupplementCard({ rec, index = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const icon = getSupplementIcon(rec.name);
  const pColor = priorityColor[rec.priority] || '#6b7280';
  const pIcon = priorityIcon[rec.priority] || '⚪';

  return (
    <div className="rec-card">
      <div className="rec-card-top">
        <div className="rec-icon-name">
          <span className="rec-icon">{icon}</span>
          <h3 className="rec-name">{rec.name}</h3>
        </div>
        <div className="rec-badges">
          <span className="rec-priority" style={{ background: pColor + '15', color: pColor, border: `1px solid ${pColor}30` }}>
            {pIcon} {rec.priority}
          </span>
          {rec.severityLevel && (
            <span className="rec-severity" style={{ background: (severityColor[rec.severityLevel] || '#6b7280') + '15', color: severityColor[rec.severityLevel] || '#6b7280' }}>
              {rec.severityLevel}
            </span>
          )}
        </div>
      </div>

      {rec.confidenceScore && <ConfidenceBar score={rec.confidenceScore} delay={index * 120} />}

      {rec.triggeredBy && (
        <div className="rec-triggered">
          <span className="rec-triggered-label">Why recommended:</span> {rec.triggeredBy}
        </div>
      )}

      <p className="rec-reason">{rec.reason}</p>

      <div className="rec-details">
        <div className="rec-detail">
          <span className="rec-detail-label">💊 Dosage</span>
          <span>{rec.dosage}</span>
        </div>
        <div className="rec-detail">
          <span className="rec-detail-label">⏰ Best Time</span>
          <span>{rec.timing}</span>
        </div>
        {rec.interactions && rec.interactions !== 'None identified' && (
          <div className="rec-detail rec-interaction">
            <span className="rec-detail-label">⚠ Interactions</span>
            <span>{rec.interactions}</span>
          </div>
        )}
      </div>

      <button className="rec-expand-btn" onClick={() => setExpanded(!expanded)}>
        {expanded ? '▲ Less details' : '▼ More details'}
      </button>

      {expanded && (
        <div className="rec-expanded">
          {rec.evidence && (
            <div className="rec-expanded-section">
              <span className="rec-expanded-label">📚 Evidence</span>
              <p>{rec.evidence}</p>
            </div>
          )}
          {rec.foods && (
            <div className="rec-expanded-section">
              <span className="rec-expanded-label">🥗 Food Sources</span>
              <p>{rec.foods}</p>
            </div>
          )}
          {rec.sideEffects && (
            <div className="rec-expanded-section">
              <span className="rec-expanded-label">⚠ Side Effects & Safe Limits</span>
              <p>{rec.sideEffects}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { recommendations: r, assessment, garbageFields = [] } = location.state || {};
  const [exporting, setExporting] = useState(false);

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      exportResultsToPDF(r, assessment);
    } finally {
      // Small delay so the button state is visible
      setTimeout(() => setExporting(false), 800);
    }
  };

  if (!r) {
    return (
      <div className="results-wrapper">
        <Navbar />
        <div className="results-container">
          <div className="results-card-simple">
            <div className="results-icon">✅</div>
            <h2>Assessment Complete!</h2>
            <p>Your health profile has been saved.</p>
            <button className="btn-primary" onClick={() => navigate('/assessment')}>Take Assessment</button>
          </div>
        </div>
      </div>
    );
  }

  const highPriority = r.recommendations?.filter(rec => rec.priority === 'High') || [];
  const otherPriority = r.recommendations?.filter(rec => rec.priority !== 'High') || [];

  return (
    <div className="results-wrapper">
      <Navbar />
      <div className="results-container">

        {/* Medical Disclaimer Banner */}
        <div className="results-disclaimer-banner">
          <span className="disclaimer-icon">ℹ️</span>
          <p>This information is for <strong>educational and wellness purposes only</strong> and does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen.</p>
        </div>

        {/* Consult Doctor Alert */}
        {r.consultDoctor && r.consultReason && (
          <div className="results-consult-alert">
            <span className="consult-icon">🏥</span>
            <div>
              <strong>Medical Consultation Recommended</strong>
              <p>{r.consultReason}</p>
            </div>
          </div>
        )}

        {/* Summary */}
        <div className="results-header">
          <h2>Your Personalized Health Plan</h2>
          <p className="results-summary">{r.summary}</p>
        </div>

        {/* Garbage input warning */}
        {garbageFields.length > 0 && (
          <div className="results-garbage-warning">
            <span className="results-garbage-icon">⚠️</span>
            <div>
              <strong>Some of your inputs were unreadable and were not used.</strong>
              <p style={{ marginBottom: '8px' }}>
                The following {garbageFields.length === 1 ? 'field' : 'fields'} contained unrecognizable text and {garbageFields.length === 1 ? 'was' : 'were'} cleared. Please retake the assessment with plain, readable descriptions for more accurate recommendations.
              </p>
              <ul className="results-garbage-list">
                {garbageFields.map((g, i) => (
                  <li key={i}>
                    <strong>{g.label}:</strong>{' '}
                    <span className="results-garbage-value">"{g.value}"</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* High Priority Supplements */}
        {highPriority.length > 0 && (
          <>
            <div className="results-section-title">💊 Priority Supplements</div>
            <p className="results-section-sub">These are most relevant to your reported symptoms and health profile.</p>
            <div className="results-grid">
              {highPriority.map((rec, i) => <SupplementCard key={i} rec={rec} index={i} />)}
            </div>
          </>
        )}

        {/* Optional Supplements */}
        {otherPriority.length > 0 && (
          <>
            <div className="results-section-title">✨ Optional Supplements</div>
            <p className="results-section-sub">These may provide additional support based on your goals and lifestyle.</p>
            <div className="results-grid">
              {otherPriority.map((rec, i) => <SupplementCard key={i} rec={rec} index={highPriority.length + i} />)}
            </div>
          </>
        )}

        {/* Daily Schedule */}
        {r.dailySchedule?.length > 0 && (
          <>
            <div className="results-section-title">🕐 Personalized Daily Schedule</div>
            <div className="daily-schedule">
              {r.dailySchedule.map((slot, i) => (
                <div key={i} className="schedule-slot">
                  <div className="schedule-time">{slot.time}</div>
                  <div className="schedule-supplements">
                    {slot.supplements.map((s, si) => (
                      <span key={si} className="schedule-pill">{s}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Lifestyle Advice */}
        {r.lifestyleAdvice?.length > 0 && (
          <>
            <div className="results-section-title">🌿 Lifestyle Recommendations</div>
            <div className="lifestyle-grid">
              {r.lifestyleAdvice.map((item, i) => (
                <div key={i} className="lifestyle-card">
                  <div className="lifestyle-category">{item.category}</div>
                  <p className="lifestyle-advice">{item.advice}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Meal Recommendations */}
        {r.mealRecommendations?.length > 0 && (
          <>
            <div className="results-section-title">🍽️ Meal Recommendations</div>
            <div className="meal-grid">
              {r.mealRecommendations.map((meal, i) => (
                <div key={i} className="meal-card">
                  <div className="meal-type">{meal.meal}</div>
                  <p className="meal-suggestion">{meal.suggestion}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Action Plan */}
        {r.actionPlan?.length > 0 && (
          <>
            <div className="results-section-title">📋 Your Action Plan</div>
            <div className="action-plan">
              {r.actionPlan.map((step, i) => (
                <div key={i} className="action-step">
                  <div className="action-step-num">{i + 1}</div>
                  <p>{step}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Avoid List */}
        {r.avoidList?.length > 0 && (
          <div className="results-avoid">
            <h4>🚫 Supplements to Avoid</h4>
            <ul>{r.avoidList.map((item, i) => <li key={i}>{item}</li>)}</ul>
          </div>
        )}

        {/* Warnings */}
        {r.warnings?.length > 0 && (
          <div className="results-warnings">
            <h4>⚠️ Important Warnings</h4>
            <ul>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}

        {/* Source note */}
        <div className="results-sources">
          <p>📖 <strong>Evidence Sources:</strong> Recommendations are informed by NIH Office of Dietary Supplements, PubMed clinical studies, Mayo Clinic guidelines, World Health Organization nutrition guidelines, and peer-reviewed clinical nutrition research. This system uses rule-based clinical logic as a wellness guidance tool, not a diagnostic system.</p>
        </div>

        <p className="results-disclaimer">{r.disclaimer}</p>

        <div className="results-actions">
          <button className="btn-export-pdf" onClick={handleExportPDF} disabled={exporting}>
            {exporting ? (
              <>⏳ Generating PDF...</>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Export PDF
              </>
            )}
          </button>
          <button className="btn-secondary" onClick={() => navigate('/history')}>View History</button>
          <button className="btn-secondary" onClick={() => navigate('/assessment')}>Retake Assessment</button>
          <button className="btn-primary" onClick={() => navigate('/')}>Back to Home</button>
        </div>

      </div>
    </div>
  );
}

export default ResultsPage;
