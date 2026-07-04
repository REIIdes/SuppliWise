import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { getInsights } from '../api';
import './InsightsPage.css';

function InsightsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasData, setHasData] = useState(false);
  const [hasAssessment, setHasAssessment] = useState(false);
  
  // Overview data
  const [overviewStats, setOverviewStats] = useState([]);
  const [currentPhase, setCurrentPhase] = useState(null);
  const [allPhases, setAllPhases] = useState([]);
  const [lifestyleAdvice, setLifestyleAdvice] = useState([]);

  // Adherence data
  const [adherenceTrends, setAdherenceTrends] = useState([]);

  // Today's progress data
  const [todaysSupplements, setTodaysSupplements] = useState([]);
  const [todaysStats, setTodaysStats] = useState({ taken: 0, total: 0, percentage: 0 });

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }

    fetchInsightsData();
  }, [navigate]);

  const fetchInsightsData = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await getInsights();

      if (!data.hasData) {
        // Set empty state for new users
        setHasData(true); // Show UI instead of error
        setHasAssessment(data.hasAssessment !== undefined ? data.hasAssessment : false);
        setOverviewStats([
          { icon: 'trophy', label: 'Longest Streak', value: 'None Yet', color: 'purple' },
          { icon: 'heart', label: 'Adherence rate', value: '0%', color: 'blue' },
          { icon: 'trend', label: 'Wellness Score', value: '0', color: 'green' },
          { icon: 'clipboard', label: 'Assessments Completed', value: '0', color: 'pink' },
        ]);
        setCurrentPhase(null);
        setAllPhases([]);
        setLifestyleAdvice([]);
        setAdherenceTrends([]);
        setTodaysSupplements([]);
        setTodaysStats({ taken: 0, total: 0, percentage: 0 });
        setLoading(false);
        return;
      }

      setHasData(true);
      setHasAssessment(true);

      // Set overview stats
      const stats = [
        { 
          icon: 'trophy', 
          label: 'Longest Streak', 
          value: data.overview.longestStreak === 0
            ? 'None Yet'
            : data.overview.longestStreak === 1
              ? '1 Day'
              : `${data.overview.longestStreak} Days`,
          color: 'purple' 
        },
        { 
          icon: 'heart', 
          label: 'Adherence rate', 
          value: `${data.overview.overallAdherence || 0}%`, 
          color: 'blue' 
        },
        { 
          icon: 'trend', 
          label: 'Wellness Score', 
          value: data.overview.wellnessScore?.toString() || '0', 
          color: 'green' 
        },
        { 
          icon: 'clipboard', 
          label: 'Assessments Completed', 
          value: data.overview.assessmentsCompleted?.toString() || '0',
          color: 'pink' 
        },
      ];
      setOverviewStats(stats);

      setCurrentPhase(data.currentPhase);
      setAllPhases(data.allPhases || []);
      setLifestyleAdvice(data.lifestyleAdvice || []);
      setAdherenceTrends(data.adherenceTrends || []);

      // Set today's progress data
      setTodaysSupplements(data.todaysSupplements || []);
      const taken = (data.todaysSupplements || []).filter(s => s.taken).length;
      const total = (data.todaysSupplements || []).length;
      const percentage = total > 0 ? Math.round((taken / total) * 100) : 0;
      setTodaysStats({ taken, total, percentage });

      setLoading(false);
    } catch (err) {
      console.error('Error fetching insights:', err);
      // Set empty state instead of error
      setHasData(true); // Show UI instead of error
      setHasAssessment(false); // No assessment on error
      setOverviewStats([
        { icon: 'trophy', label: 'Longest Streak', value: 'None Yet', color: 'purple' },
        { icon: 'heart', label: 'Adherence rate', value: '0%', color: 'blue' },
        { icon: 'trend', label: 'Wellness Score', value: '0', color: 'green' },
        { icon: 'clipboard', label: 'Assessments Completed', value: '0', color: 'pink' },
      ]);
      setCurrentPhase(null);
      setAllPhases([]);
      setLifestyleAdvice([]);
      setAdherenceTrends([]);
      setTodaysSupplements([]);
      setTodaysStats({ taken: 0, total: 0, percentage: 0 });
      setLoading(false);
    }
  };

  const getIconSvg = (iconType) => {
    switch (iconType) {
      case 'trend':
        return (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
            <polyline points="16 7 22 7 22 13"/>
          </svg>
        );
      case 'heart':
        return (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        );
      case 'fire':
        return (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        );
      case 'trophy':
        return (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
            <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
            <path d="M4 22h16"/>
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
            <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
          </svg>
        );
      case 'clipboard':
        return (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
            <path d="M9 14l2 2 4-4"/>
          </svg>
        );
      case 'bolt':
        return (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
        );
      case 'energy':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
        );
      case 'adherence':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        );
      case 'sleep':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        );
      case 'brain':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a10 10 0 0 1 7.94 16.06L12 22l-7.94-3.94A10 10 0 0 1 12 2z"/>
            <circle cx="12" cy="11" r="3"/>
          </svg>
        );
      default:
        return null;
    }
  };

  const renderOverview = () => (
    <>
      {/* Current Phase Insights */}
      {currentPhase ? (
        <div className="insights-section">
          <h3 className="insights-section-title">Your Current Phase</h3>
          <div className="current-phase-card">
            <h4 className="phase-title">{currentPhase.phase}</h4>
            <p className="phase-focus">{currentPhase.focus}</p>
            {currentPhase.steps && currentPhase.steps.length > 0 && (
              <div className="phase-steps">
                <h5>Action Steps:</h5>
                <ul>
                  {currentPhase.steps.map((step, idx) => (
                    <li key={idx}>{step}</li>
                  ))}
                </ul>
              </div>
            )}
            {currentPhase.expectedChanges && currentPhase.expectedChanges.length > 0 && (
              <div className="phase-changes">
                <h5>Expected Changes:</h5>
                <ul>
                  {currentPhase.expectedChanges.map((change, idx) => (
                    <li key={idx}>{change}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="insights-section">
          <h3 className="insights-section-title">Start Your Wellness Journey</h3>
          <div className="empty-state-message" style={{ textAlign: 'center', padding: '60px 20px' }}>
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 16px', color: '#10b981' }}>
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              <path d="M3.22 12h3.14L8 8l4 8 1.64-4h3.14"/>
            </svg>
            <p style={{ color: '#6b7280', marginBottom: '0' }}>
              Complete an assessment to get personalized AI insights and action plans.
            </p>
          </div>
        </div>
      )}

      {/* Lifestyle Advice */}
      {lifestyleAdvice.length > 0 && (
        <div className="insights-section">
          <h3 className="insights-section-title">Lifestyle Recommendations</h3>
          <div className="lifestyle-grid">
            {lifestyleAdvice.map((advice, index) => (
              <div key={index} className="lifestyle-card">
                <h4 className="lifestyle-category">{advice.category}</h4>
                <p className="lifestyle-advice">{advice.advice}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const renderTodaysProgress = () => (
    <>
      {/* Progress Summary */}
      <div className="insights-section">
        <h3 className="insights-section-title">Today's Supplement Progress</h3>
        
        {todaysSupplements.length === 0 ? (
          <div className="empty-state-progress">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <p>No supplements scheduled for today.</p>
            <p className="empty-state-note">
              {hasAssessment
                ? 'Add supplements to your plan from recommendations to start tracking.'
                : 'Complete an assessment to get your personalized supplement plan and start tracking.'}
            </p>
          </div>
        ) : (
          <>
            {/* Progress Stats */}
            <div className="progress-summary-card">
              <div className="progress-circle-container">
                <svg className="progress-circle" width="160" height="160">
                  <circle
                    cx="80"
                    cy="80"
                    r="70"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="12"
                  />
                  <circle
                    cx="80"
                    cy="80"
                    r="70"
                    fill="none"
                    stroke={todaysStats.percentage === 100 ? '#10b981' : todaysStats.percentage >= 50 ? '#f59e0b' : '#ef4444'}
                    strokeWidth="12"
                    strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 70}`}
                    strokeDashoffset={`${2 * Math.PI * 70 * (1 - todaysStats.percentage / 100)}`}
                    transform="rotate(-90 80 80)"
                  />
                </svg>
                <div className="progress-text">
                  <div className="progress-percentage">{todaysStats.percentage}%</div>
                  <div className="progress-count">{todaysStats.taken} of {todaysStats.total}</div>
                </div>
              </div>
              <div className="progress-message">
                {todaysStats.percentage === 100 ? (
                  <>
                    <h4>🎉 Perfect Day!</h4>
                    <p>You've taken all your supplements today. Keep up the great work!</p>
                  </>
                ) : todaysStats.percentage >= 50 ? (
                  <>
                    <h4>👍 Making Progress!</h4>
                    <p>You're over halfway there. Finish strong!</p>
                  </>
                ) : todaysStats.percentage > 0 ? (
                  <>
                    <h4>🌱 Getting Started!</h4>
                    <p>Good start! Keep going to reach your daily goal.</p>
                  </>
                ) : (
                  <>
                    <h4>⏰ Time to Start!</h4>
                    <p>Take your first supplement to begin today's progress.</p>
                  </>
                )}
              </div>
            </div>

            {/* Today's Supplement List */}
            <div className="todays-supplements-list">
              <h4 className="subsection-title">Today's Supplements</h4>
              <div className="supplements-grid">
                {todaysSupplements.map((supplement, index) => (
                  <div 
                    key={index} 
                    className={`supplement-progress-item ${supplement.taken ? 'completed' : 'pending'}`}
                  >
                    <div className="supplement-status-icon">
                      {supplement.taken ? (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/>
                        </svg>
                      )}
                    </div>
                    <div className="supplement-progress-info">
                      <h5 className="supplement-progress-name">{supplement.name}</h5>
                      <p className="supplement-progress-details">{supplement.dosage}</p>
                      <p className="supplement-progress-time">
                        {supplement.taken 
                          ? `✓ Taken at ${new Date(supplement.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                          : `⏰ ${supplement.scheduledTime}`
                        }
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );

  const renderAdherence = () => (
    <>
      {/* Weekly Adherence Chart */}
      <div className="insights-section">
        <h3 className="insights-section-title">Recent Adherence Pattern</h3>
        {adherenceTrends.length > 0 ? (
          <div className="adherence-weekly-grid">
            {adherenceTrends.map((trend) => {
              const dayName = new Date(trend.date).toLocaleDateString('en-US', { weekday: 'short' });
              return (
                <div key={trend.date} className="adherence-day-column">
                  <div className="adherence-bar-container">
                    <div 
                      className="adherence-bar" 
                      style={{ 
                        height: `${trend.percentage}%`,
                        background: trend.percentage >= 100 ? '#10b981' : trend.percentage >= 80 ? '#f59e0b' : '#ef4444'
                      }}
                    ></div>
                  </div>
                  <p className="adherence-day-label">{dayName}</p>
                  <p className="adherence-day-percentage">{trend.percentage}%</p>
                  <p className="adherence-day-count">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '4px', verticalAlign: 'middle' }}>
                      <path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
                    </svg>
                    {trend.taken} of {trend.total}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state-progress">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <p>No adherence data yet.</p>
            <p className="empty-state-note">
              {hasAssessment
                ? 'Add supplements to your plan from recommendations to start building your adherence history.'
                : 'Complete an assessment to start building your adherence history and track your progress.'}
            </p>
          </div>
        )}
      </div>

      {/* All Action Plan Phases */}
      {allPhases.length > 0 && (
        <div className="insights-section">
          <h3 className="insights-section-title">Your Wellness Journey Phases</h3>
          <div className="phases-list">
            {allPhases.map((phase, index) => (
              <div key={index} className="phase-item">
                <div className="phase-number">{index + 1}</div>
                <div className="phase-details">
                  <h4 className="phase-name">{phase.phase}</h4>
                  <p className="phase-description">{phase.focus}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const renderAIInsight = () => (
    <>
      {currentPhase ? (
        <>
          <div className="insights-section">
            <h3 className="insights-section-title">AI-Powered Phase Guidance</h3>
            <div className="current-phase-card ai-enhanced">
              <div className="ai-badge">AI Insight</div>
              <h4 className="phase-title">{currentPhase.phase}</h4>
              <p className="phase-focus">{currentPhase.focus}</p>
              {currentPhase.steps && currentPhase.steps.length > 0 && (
                <div className="phase-steps">
                  <h5>Recommended Actions:</h5>
                  <ul>
                    {currentPhase.steps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                </div>
              )}
              {currentPhase.expectedChanges && currentPhase.expectedChanges.length > 0 && (
                <div className="phase-changes">
                  <h5>What to Expect:</h5>
                  <ul>
                    {currentPhase.expectedChanges.map((change, idx) => (
                      <li key={idx}>{change}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {lifestyleAdvice.length > 0 && (
            <div className="insights-section">
              <h3 className="insights-section-title">Personalized Lifestyle Tips</h3>
              <div className="lifestyle-grid">
                {lifestyleAdvice.map((advice, index) => (
                  <div key={index} className="lifestyle-card">
                    <div className="lifestyle-icon">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                      </svg>
                    </div>
                    <h4 className="lifestyle-category">{advice.category}</h4>
                    <p className="lifestyle-advice">{advice.advice}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="insights-section">
          <h3 className="insights-section-title">AI Insights Await</h3>
          <div className="empty-state-message" style={{ textAlign: 'center', padding: '60px 20px' }}>
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 16px', color: '#10b981' }}>
              {/* Speech bubble */}
              <path d="M20 6 L40 6 Q46 6 46 12 L46 18 Q46 24 40 24 L34 24 L28 30 L28 24 L20 24 Q14 24 14 18 L14 12 Q14 6 20 6 Z" fill="none" stroke="currentColor" strokeWidth="2.5"/>
              {/* Robot head */}
              <rect x="14" y="34" width="36" height="24" rx="4" ry="4" fill="none" stroke="currentColor" strokeWidth="2.5"/>
              {/* Antenna */}
              <line x1="32" y1="28" x2="32" y2="34" stroke="currentColor" strokeWidth="2.5"/>
              <circle cx="32" cy="26" r="2.5" fill="currentColor"/>
              {/* Eyes */}
              <circle cx="24" cy="44" r="2.5" fill="currentColor"/>
              <circle cx="40" cy="44" r="2.5" fill="currentColor"/>
              {/* Smile */}
              <path d="M24 50 Q32 54 40 50" fill="none" stroke="currentColor" strokeWidth="2.5"/>
            </svg>
            <p style={{ color: '#6b7280', marginBottom: '0' }}>
              Complete an assessment to unlock personalized AI-powered guidance and recommendations.
            </p>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="insights-wrapper">
      <Navbar />
      
      <div className="insights-container">
        {/* Header */}
        <div className="insights-header">
          <h1 className="insights-title">Health Insights</h1>
          <p className="insights-subtitle">Track your progress and see how supplements are impacting your wellness</p>
        </div>

        {/* Tabs */}
        <div className="insights-tabs">
          <button
            className={`insights-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            className={`insights-tab ${activeTab === 'progress' ? 'active' : ''}`}
            onClick={() => setActiveTab('progress')}
          >
            Today's Progress
          </button>
          <button
            className={`insights-tab ${activeTab === 'adherence' ? 'active' : ''}`}
            onClick={() => setActiveTab('adherence')}
          >
            Adherence
          </button>
          <button
            className={`insights-tab ${activeTab === 'ai' ? 'active' : ''}`}
            onClick={() => setActiveTab('ai')}
          >
            AI Insight
          </button>
        </div>

        {/* Content */}
        <div className="insights-content">
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'progress' && renderTodaysProgress()}
          {activeTab === 'adherence' && renderAdherence()}
          {activeTab === 'ai' && renderAIInsight()}
        </div>
      </div>
    </div>
  );
}

export default InsightsPage;
