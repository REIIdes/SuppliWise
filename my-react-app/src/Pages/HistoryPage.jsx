import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { getHistory, deleteAssessment } from '../api';
import { exportResultsToPDF } from '../utils/exportPDF';
import './HistoryPage.css';

const priorityColor = { High: '#dc2626', Medium: '#d97706', Low: '#374151' };

const ACTIVITY_LABELS = {
  Sedentary: 'Sedentary',
  Light:     'Light',
  Moderate:  'Moderate',
  Very:      'Very Active',
};

// Map generic food category words to specific examples
const FOOD_SPECIFICS = {
  'fatty fish':       'fatty fish (salmon, tuna, sardines, mackerel)',
  'leafy greens':     'leafy greens (spinach, kale, Swiss chard)',
  'leafy green':      'leafy greens (spinach, kale, Swiss chard)',
  'nuts':             'nuts (almonds, cashews, walnuts, pumpkin seeds)',
  'dairy':            'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'dairy products':   'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'citrus':           'citrus (oranges, grapefruit, kiwi)',
  'citrus fruits':    'citrus (oranges, grapefruit, kiwi)',
  'legumes':          'legumes (lentils, chickpeas, black beans)',
  'whole grains':     'whole grains (oats, brown rice, quinoa)',
  'lean meats':       'lean meats (chicken breast, turkey, lean beef)',
  'lean meat':        'lean meats (chicken breast, turkey, lean beef)',
  'red meat':         'red meat (beef, lamb, bison)',
  'shellfish':        'shellfish (oysters, clams, crab, shrimp)',
  'seeds':            'seeds (pumpkin seeds, sunflower seeds, chia seeds)',
  'berries':          'berries (blueberries, strawberries, raspberries)',
  'cruciferous vegetables': 'cruciferous vegetables (broccoli, Brussels sprouts, cauliflower)',
  'organ meats':      'organ meats (beef liver, chicken liver)',
  'fermented foods':  'fermented foods (kefir, kimchi, sauerkraut, miso)',
};

function expandFoodText(text) {
  if (!text) return text;
  // Strip sentence fragments first
  let cleaned = text
    .replace(/,?\s*(such as|which are|are naturally|naturally rich|found in|including)[^,;]*/gi, '')
    .replace(/,?\s*are\s+[a-z].*$/gi, '')
    .trim()
    .replace(/,\s*$/, '');
  cleaned = cleaned || text;
  // Then expand generic category words
  for (const [key, expanded] of Object.entries(FOOD_SPECIFICS)) {
    const regex = new RegExp(`\\b${key}\\b`, 'gi');
    cleaned = cleaned.replace(regex, expanded);
  }
  return cleaned;
}

// ── Delete Confirmation Modal ──────────────────────────────────────────────
function DeleteModal({ onConfirm, onCancel, loading }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-icon">🗑️</div>
        <h3 className="modal-title">Delete Assessment?</h3>
        <p className="modal-body">
          This will permanently remove this assessment and its AI analysis from your history. This action cannot be undone.
        </p>
        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onCancel} disabled={loading}>
            Keep it
          </button>
          <button className="modal-btn-confirm" onClick={onConfirm} disabled={loading}>
            {loading ? 'Deleting...' : 'Yes, delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryPage() {
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null); // id of item to delete
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState({});
  const [toast, setToast] = useState('');
  const [showAllSupplements, setShowAllSupplements] = useState({});

  const toggleShowAllSupplements = (assessmentId) => {
    setShowAllSupplements(prev => ({ ...prev, [assessmentId]: !prev[assessmentId] }));
  };

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { navigate('/login'); return; }
    getHistory()
      .then(setHistory)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [navigate]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const fmt = (dateStr) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAssessment(deleteTarget);
      setHistory(prev => prev.filter(h => h._id !== deleteTarget));
      setExpanded(null);
      showToast('Assessment deleted successfully.');
    } catch (err) {
      showToast('Failed to delete. Please try again.');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const getTab = (id) => activeTab[id] || 'assessment';
  const setTab = (id, tab) => setActiveTab(prev => ({ ...prev, [id]: tab }));

  return (
    <div className="history-wrapper">
      <Navbar />

      {/* Delete Modal */}
      {deleteTarget && (
        <DeleteModal
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          loading={deleting}
        />
      )}

      {/* Toast */}
      {toast && <div className="history-toast">{toast}</div>}

      <div className="history-container">
        <div className="history-header">
          <h2>Assessment History</h2>
          <button className="btn-primary" onClick={() => navigate('/assessment')}>
            + New Assessment
          </button>
        </div>

        {loading && <p className="history-status">Loading history...</p>}
        {error && (
          <div className="history-error-box">
            <div className="history-error-icon">⚠️</div>
            <p className="history-error-title">Could not load your history</p>
            <p className="history-error-msg">{error}</p>
            <button className="btn-primary" onClick={() => window.location.reload()}>Try Again</button>
          </div>
        )}
        {!loading && !error && history.length === 0 && (
          <div className="history-empty">
            <div className="history-empty-icon">📋</div>
            <p style={{ fontWeight: 600, color: '#374151', fontSize: '16px', margin: 0 }}>No assessments yet</p>
            <p style={{ margin: 0 }}>Complete your first health assessment to get personalized supplement and lifestyle recommendations.</p>
            <button className="btn-primary" onClick={() => navigate('/assessment')}>
              Start Assessment →
            </button>
          </div>
        )}

        <div className="history-list">
          {history.map((item, i) => (
            <div key={item._id} className="history-card">
              {/* Card Header */}
              <div className="history-card-header" onClick={() => setExpanded(expanded === i ? null : i)}>
                <div className="history-card-header-left">
                  <span className="history-date">{fmt(item.createdAt)}</span>
                  <div className="history-card-title">
                    {item.symptoms?.length > 0
                      ? item.symptoms.slice(0, 2).join(', ') + (item.symptoms.length > 2 ? ` +${item.symptoms.length - 2} more` : '')
                      : item.healthGoals?.length > 0
                        ? item.healthGoals.slice(0, 2).join(', ')
                        : 'General Wellness Assessment'}
                  </div>
                  <div className="history-tags">
                    {item.age && <span className="tag tag-blue">Age {item.age}</span>}
                    {item.dietType && <span className="tag">{item.dietType}</span>}
                    {item.activityLevel && <span className="tag">{ACTIVITY_LABELS[item.activityLevel] || item.activityLevel}</span>}
                    {item.symptoms?.length > 0 && (
                      <span className="tag tag-red">{item.symptoms.length} symptom{item.symptoms.length > 1 ? 's' : ''}</span>
                    )}
                    {item.aiResults && <span className="tag tag-green">✓ AI Analysis</span>}
                  </div>
                </div>
                <div className="history-card-header-right">
                  {item.aiResults && (
                    <button
                      className="btn-view-results"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate('/results', { state: { recommendations: item.aiResults, assessment: item } });
                      }}
                      title="View full results"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    </button>
                  )}
                  {item.aiResults && (
                    <button
                      className="btn-download-pdf"
                      onClick={(e) => {
                        e.stopPropagation();
                        exportResultsToPDF(item.aiResults, item);
                      }}
                      title="Download PDF report"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </button>
                  )}
                  <button
                    className="btn-delete"
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(item._id); }}
                    title="Delete assessment"
                  >
                    🗑
                  </button>
                  <span className="history-toggle">{expanded === i ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded Content */}
              {expanded === i && (
                <div className="history-card-body">
                  <div className="history-tabs">
                    <button className={`history-tab ${getTab(item._id) === 'assessment' ? 'active' : ''}`}
                      onClick={() => setTab(item._id, 'assessment')}>📋 Assessment</button>
                    {item.aiResults && (
                      <>
                        <button className={`history-tab ${getTab(item._id) === 'supplements' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'supplements')}>💊 Supplements</button>
                        <button className={`history-tab ${getTab(item._id) === 'schedule' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'schedule')}>🗓️ Schedule & Recovery</button>
                        <button className={`history-tab ${getTab(item._id) === 'meals' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'meals')}>🍽️ Meals</button>
                        <button className={`history-tab ${getTab(item._id) === 'lifestyle' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'lifestyle')}>🌿 Lifestyle</button>
                        {(item.aiResults.warnings?.length > 0 || item.aiResults.avoidList?.length > 0) && (
                          <button className={`history-tab history-tab-warn ${getTab(item._id) === 'warnings' ? 'active' : ''}`}
                            onClick={() => setTab(item._id, 'warnings')}>⚠️ Warnings</button>
                        )}
                      </>
                    )}
                  </div>

                  {getTab(item._id) === 'assessment' && (
                    <div className="tab-content">
                      <div className="history-grid">
                        {item.age && <div className="history-item"><span>Age</span><strong>{item.age}</strong></div>}
                        {item.gender && <div className="history-item"><span>Gender</span><strong>{item.gender}</strong></div>}
                        {item.weight && <div className="history-item"><span>Weight</span><strong>{item.weight} kg</strong></div>}
                        {item.height && <div className="history-item"><span>Height</span><strong>{item.height} cm</strong></div>}
                        {item.activityLevel && <div className="history-item"><span>Physical Activity Level</span><strong>{ACTIVITY_LABELS[item.activityLevel] || item.activityLevel}</strong></div>}
                        {item.dietType && <div className="history-item"><span>Diet</span><strong>{item.dietType}</strong></div>}
                      </div>
                      {item.healthGoals?.length > 0 && (
                        <div className="history-section">
                          <p className="history-section-label">Health Goals</p>
                          <div className="tag-list">{item.healthGoals.map(g => <span key={g} className="tag">{g}</span>)}</div>
                        </div>
                      )}
                      {item.symptoms?.length > 0 && (
                        <div className="history-section">
                          <p className="history-section-label">Symptoms</p>
                          <div className="tag-list">{item.symptoms.map(s => <span key={s} className="tag tag-red">{s}</span>)}</div>
                        </div>
                      )}
                      {item.medicalConditions?.length > 0 && !item.medicalConditions.includes('None') && (
                        <div className="history-section">
                          <p className="history-section-label">Medical Conditions</p>
                          <div className="tag-list">{item.medicalConditions.map(c => <span key={c} className="tag tag-orange">{c}</span>)}</div>
                        </div>
                      )}
                      {item.feelingDescription && (
                        <div className="history-section">
                          <p className="history-section-label">How they felt</p>
                          <p className="history-feeling">"{item.feelingDescription}"</p>
                        </div>
                      )}
                      {item.aiResults?.summary && (
                        <div className="history-section">
                          <p className="history-section-label">AI Summary</p>
                          <p className="history-feeling">{item.aiResults.summary}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'supplements' && item.aiResults && (
                    <div className="tab-content">
                      {(() => {
                        const recs = item.aiResults.recommendations || [];
                        const showAll = !!showAllSupplements[item._id];
                        const visible = showAll ? recs : recs.slice(0, 3);
                        return (
                          <>
                            {visible.map((rec, ri) => (
                              <div key={ri} className="history-rec-card">
                                <div className="history-rec-top">
                                  <strong>{rec.name}</strong>
                                  <span className="rec-priority-small"
                                    style={{ background: priorityColor[rec.priority] + '20', color: priorityColor[rec.priority] }}>
                                    {rec.priority} Priority
                                  </span>
                                </div>
                                <p className="history-rec-reason">{rec.reason}</p>
                                <div className="history-rec-meta">
                                  <span><b>Dosage:</b> {rec.dosage}</span>
                                  <span><b>Timing:</b> {rec.timing}</span>
                                </div>
                                {rec.interactions && rec.interactions !== 'None identified' && (
                                  <p className="history-rec-interaction">⚠ {rec.interactions}</p>
                                )}
                                {rec.evidence && (
                                  <p className="history-rec-evidence history-rec-evidence-blue">📚 <strong>Evidence:</strong> {rec.evidence}</p>
                                )}
                                {rec.foods && (
                                  <p className="history-rec-evidence history-rec-foods">🥗 <strong>Food Sources:</strong> {expandFoodText(rec.foods)}</p>
                                )}
                                {rec.sideEffects && (
                                  <p className="history-rec-evidence history-rec-sideeffects">⚠ <strong>Side Effects &amp; Safe Limits:</strong> {rec.sideEffects}</p>
                                )}
                              </div>
                            ))}
                            {recs.length > 3 && (
                              <button
                                className="supp-toggle-btn"
                                onClick={() => toggleShowAllSupplements(item._id)}
                              >
                                {showAll
                                  ? 'Show less ▲'
                                  : `Show more ▼  (${recs.length - 3} more supplement${recs.length - 3 > 1 ? 's' : ''})`}
                              </button>
                            )}
                          </>
                        );
                      })()}
                      {item.aiResults.avoidList?.length > 0 && (
                        <div className="history-avoid">
                          <p className="history-section-label">🚫 Avoid</p>
                          <ul>{item.aiResults.avoidList.map((a, ai) => <li key={ai}>{a}</li>)}</ul>
                        </div>
                      )}
                      {item.aiResults.warnings?.length > 0 && (
                        <div className="history-warnings">
                          <p className="history-section-label">⚠️ Warnings</p>
                          <ul>{item.aiResults.warnings.map((w, wi) => <li key={wi}>{w}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'schedule' && item.aiResults && (
                    <div className="tab-content">
                      {/* Daily Schedule */}
                      {item.aiResults.dailySchedule?.length > 0 ? (() => {
                        const dosageMap = {};
                        (item.aiResults.recommendations || []).forEach(rec => {
                          if (rec.name && rec.dosage) dosageMap[rec.name.toLowerCase()] = rec.dosage;
                        });
                        const getDosage = (pillName) => {
                          const pill = pillName.toLowerCase();
                          if (dosageMap[pill]) return dosageMap[pill];
                          for (const [recName, dosage] of Object.entries(dosageMap)) {
                            if (pill.includes(recName) || recName.includes(pill)) return dosage;
                            const pillWords = pill.split(/\s+/).filter(w => w.length > 3);
                            const recWords = recName.split(/\s+/).filter(w => w.length > 3);
                            if (pillWords.some(w => recWords.includes(w))) return dosage;
                          }
                          return null;
                        };
                        return (
                          <div className="history-schedule">
                            {item.aiResults.dailySchedule.map((slot, si) => (
                              <div key={si} className="history-schedule-slot">
                                <div className="history-schedule-time">{slot.time}</div>
                                <div className="history-schedule-pills">
                                  {slot.supplements.map((s, sj) => {
                                    const dosage = getDosage(s);
                                    return (
                                      <span key={sj} className="history-schedule-pill">
                                        {s}{dosage ? <span className="history-schedule-pill-dosage"> — {dosage}</span> : ''}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })() : (
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No daily schedule recorded for this assessment.</p>
                      )}

                      {/* Recovery Plan */}
                      {item.aiResults.actionPlan?.length > 0 && (
                        <div className="history-recovery-plan" style={{ marginTop: item.aiResults.dailySchedule?.length > 0 ? '20px' : '0' }}>
                          {item.aiResults.actionPlan.map((phase, si) => {
                            if (typeof phase === 'string') {
                              return (
                                <div key={si} className="history-recovery-phase">
                                  <div className="history-recovery-header">
                                    <span className="history-recovery-num">{si + 1}</span>
                                    <p className="history-recovery-title">{phase}</p>
                                  </div>
                                </div>
                              );
                            }
                            const steps = phase.steps?.length > 0 ? phase.steps : [
                              ...(phase.supplements || []),
                              ...(phase.habits || []),
                              ...(phase.activity || []),
                            ];
                            const expected = phase.expectedChanges || [];
                            return (
                              <div key={si} className="history-recovery-phase">
                                <div className="history-recovery-header">
                                  <span className="history-recovery-num">{si + 1}</span>
                                  <div>
                                    <p className="history-recovery-title">{phase.phase || phase.week}</p>
                                    {phase.focus && <p className="history-recovery-focus">{phase.focus}</p>}
                                  </div>
                                </div>
                                {steps.length > 0 && (
                                  <ul className="history-recovery-steps">
                                    {steps.map((step, ti) => <li key={ti}>{step}</li>)}
                                  </ul>
                                )}
                                {expected.length > 0 && (
                                  <div className="history-recovery-expected">
                                    <span className="history-recovery-expected-label">✦ Expected Changes</span>
                                    <ul>
                                      {expected.map((e, ei) => <li key={ei}>{e}</li>)}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'lifestyle' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.lifestyleAdvice?.length > 0 ? (
                        item.aiResults.lifestyleAdvice.map((la, li) => (
                          <div key={li} className="history-lifestyle-card">
                            <span className="lifestyle-category-badge">{la.category}</span>
                            <p>{la.advice}</p>
                          </div>
                        ))
                      ) : (
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No lifestyle advice recorded for this assessment.</p>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'meals' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.mealRecommendations?.length > 0 ? (
                        item.aiResults.mealRecommendations.map((meal, mi) => (
                          <div key={mi} className="history-lifestyle-card" style={{ borderColor: '#fed7aa', background: '#fff7ed' }}>
                            <span className="lifestyle-category-badge" style={{ color: '#c2410c', background: '#ffedd5' }}>{meal.meal}</span>
                            <p>{meal.suggestion}</p>
                          </div>
                        ))
                      ) : (
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No meal recommendations recorded for this assessment.</p>
                      )}
                    </div>
                  )}



                  {getTab(item._id) === 'warnings' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.warnings?.length > 0 && (
                        <div className="history-warnings-block">
                          <div className="history-warnings-title">
                            <span className="warn-icon">⚠️</span>
                            Important Warnings
                          </div>
                          <ul className="history-warnings-list">
                            {item.aiResults.warnings.map((w, wi) => (
                              <li key={wi} className="history-warning-item">{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {item.aiResults.avoidList?.length > 0 && (
                        <div className="history-avoid-block">
                          <div className="history-avoid-title">
                            <span className="avoid-icon">🚫</span>
                            Supplements to Avoid
                          </div>
                          <ul className="history-avoid-list">
                            {item.aiResults.avoidList.map((a, ai) => (
                              <li key={ai} className="history-avoid-item">{a}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!item.aiResults.warnings?.length && !item.aiResults.avoidList?.length && (
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No warnings or supplements to avoid for this assessment.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default HistoryPage;
