import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import ConfirmModal from '../Components/ConfirmModal/ConfirmModal';
import { getDashboard, updateIntake } from '../api';
import './DashboardPage.css';

function DashboardPage() {
  const navigate = useNavigate();
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [todaysSupplements, setTodaysSupplements] = useState([]);
  const [wellnessScore, setWellnessScore] = useState(0);
  const [quickStats, setQuickStats] = useState({
    daysStreak: 0,
    adherenceRate: 0,
    energyLevel: 'Medium',
    todaysProgress: { taken: 0, total: 0 },
  });
  const [insights, setInsights] = useState(null);
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const [showMarkTakenToast, setShowMarkTakenToast] = useState(false);
  const [showNewAssessmentConfirm, setShowNewAssessmentConfirm] = useState(false);

  useEffect(() => {
    // Get user data from localStorage
    const userRaw = localStorage.getItem('user');
    const token = localStorage.getItem('token');
    
    if (!token) {
      navigate('/login');
      return;
    }

    if (userRaw) {
      const user = JSON.parse(userRaw);
      setUserData(user);
    }

    fetchDashboardData();
  }, [navigate]);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await getDashboard();
      
      if (!data.hasAssessment) {
        // Set empty/default state for new users without assessment
        setTodaysSupplements([]);
        setWellnessScore(0);
        setQuickStats({
          daysStreak: 0,
          adherenceRate: 0,
          energyLevel: 'Medium',
          todaysProgress: { taken: 0, total: 0 },
        });
        setInsights(null);
        setLoading(false);
        return;
      }

      // Sort supplements: untaken first (by schedule time, then priority), then taken last (by schedule time, then priority)
      const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
      const TIME_ORDER = {
        'morning': 0, 'breakfast': 0, 'before breakfast': 0, 'with breakfast': 0,
        'lunch': 1, 'afternoon': 1, 'midday': 1, 'with lunch': 1,
        'dinner': 2, 'evening': 2, 'night': 2, 'bedtime': 2, 'before bed': 2, 'with dinner': 2,
        'anytime': 3
      };
      
      const getTimeOrder = (scheduledTime) => {
        if (!scheduledTime) return 3;
        const time = scheduledTime.toLowerCase();
        for (const [key, value] of Object.entries(TIME_ORDER)) {
          if (time.includes(key)) return value;
        }
        return 3;
      };
      
      const sortedSupplements = (data.todaysSupplements || []).sort((a, b) => {
        // First: taken status (untaken first, taken last)
        if (a.taken !== b.taken) return a.taken ? 1 : -1;
        
        // Then: schedule time (morning → lunch → evening)
        const ta = getTimeOrder(a.scheduledTime);
        const tb = getTimeOrder(b.scheduledTime);
        if (ta !== tb) return ta - tb;
        
        // Finally: priority (High → Medium → Low)
        const pa = PRIORITY_ORDER[a.priority] ?? 3;
        const pb = PRIORITY_ORDER[b.priority] ?? 3;
        return pa - pb;
      });

      setTodaysSupplements(sortedSupplements);
      setWellnessScore(data.stats.wellnessScore || 0);
      setQuickStats({
        daysStreak: data.stats.daysStreak || 0,
        adherenceRate: data.stats.adherenceRate || 0,
        energyLevel: data.stats.energyLevel || 'Medium',
        todaysProgress: data.stats.todaysProgress || { taken: 0, total: 0 },
      });
      setInsights(data.insights);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching dashboard:', err);
      setError(err.message || 'Failed to load dashboard data.');
      setLoading(false);
    }
  };

  const handleSupplementToggle = async (id) => {
    const supplement = todaysSupplements.find(s => s.id === id);
    if (!supplement) return;

    const newTakenState = !supplement.taken;

    // Optimistically update UI
    setTodaysSupplements((prev) => {
      const updated = prev.map((sup) => 
        sup.id === id 
          ? { 
              ...sup, 
              taken: newTakenState,
              takenAt: newTakenState ? new Date() : null,
            } 
          : sup
      );
      // Sort: by priority (High → Medium → Low), then by schedule time, then by taken status
      const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
      const TIME_ORDER = {
        'morning': 0, 'breakfast': 0, 'before breakfast': 0, 'with breakfast': 0,
        'lunch': 1, 'afternoon': 1, 'midday': 1, 'with lunch': 1,
        'dinner': 2, 'evening': 2, 'night': 2, 'bedtime': 2, 'before bed': 2, 'with dinner': 2,
        'anytime': 3
      };
      
      const getTimeOrder = (scheduledTime) => {
        if (!scheduledTime) return 3;
        const time = scheduledTime.toLowerCase();
        for (const [key, value] of Object.entries(TIME_ORDER)) {
          if (time.includes(key)) return value;
        }
        return 3;
      };
      
      return updated.sort((a, b) => {
        // First: taken status (untaken first, taken last)
        if (a.taken !== b.taken) return a.taken ? 1 : -1;
        
        // Then: schedule time (morning → lunch → evening)
        const ta = getTimeOrder(a.scheduledTime);
        const tb = getTimeOrder(b.scheduledTime);
        if (ta !== tb) return ta - tb;
        
        // Finally: priority (High → Medium → Low)
        const pa = PRIORITY_ORDER[a.priority] ?? 3;
        const pb = PRIORITY_ORDER[b.priority] ?? 3;
        return pa - pb;
      });
    });

    try {
      const result = await updateIntake(id, newTakenState);
      
      // Update stats from server response
      if (result.stats) {
        setQuickStats(prev => ({
          ...prev,
          adherenceRate: result.stats.overallAdherence,
          daysStreak: result.stats.daysStreak,
          todaysProgress: result.stats.todaysProgress,
        }));
        setWellnessScore(result.stats.wellnessScore);
        
        // Check if all supplements are now taken
        if (result.stats.todaysProgress.taken === result.stats.todaysProgress.total && 
            result.stats.todaysProgress.total > 0) {
          setShowCompletionToast(true);
          // Auto-hide after 4 seconds
          setTimeout(() => setShowCompletionToast(false), 4000);
        } else if (newTakenState) {
          // Show small toast when marking as taken (but not completed all)
          setShowMarkTakenToast(true);
          setTimeout(() => setShowMarkTakenToast(false), 2000);
        }
      }
    } catch (err) {
      console.error('Error updating intake:', err);
      // Revert optimistic update on error
      setTodaysSupplements((prev) =>
        prev.map((sup) =>
          sup.id === id ? { ...sup, taken: !newTakenState, takenAt: supplement.takenAt } : sup
        )
      );
    }
  };

  const navigateToCard = (cardName) => {
    switch (cardName) {
      case 'assessment':
        // Check if user has supplements that haven't been taken today
        const hasUnfinishedSupplements = todaysSupplements.some(s => !s.taken);
        if (hasUnfinishedSupplements && todaysSupplements.length > 0) {
          setShowNewAssessmentConfirm(true);
        } else {
          // Just navigate to assessment - don't force clear if there's in-progress work
          navigate('/assessment');
        }
        break;
      case 'recommendations':
        navigate('/recommendations');
        break;
      case 'track':
        navigate('/track-intake');
        break;
      case 'insights':
        navigate('/insights');
        break;
      default:
        break;
    }
  };

  const confirmNewAssessment = () => {
    setShowNewAssessmentConfirm(false);
    // When explicitly confirming to abandon current supplements, then clear draft
    navigate('/assessment', { state: { clearDraft: true } });
  };

  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading your dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-wrapper">
        <Navbar />
        <div className="dashboard-container">
          <div className="dashboard-error">
            <p>{error}</p>
            <button onClick={() => navigate('/assessment')} className="btn-primary">
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!userData) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>Loading your dashboard...</p>
      </div>
    );
  }

  return (
    <div className="dashboard-wrapper">
      <Navbar />

      {/* New Assessment Confirmation Modal */}
      {showNewAssessmentConfirm && (
        <ConfirmModal
          title="Start New Assessment?"
          message="You have supplements you haven't taken today. Starting a new assessment will replace your current plan. Are you sure you want to continue?"
          confirmText="Start New Assessment"
          cancelText="Cancel"
          type="warning"
          onConfirm={confirmNewAssessment}
          onCancel={() => setShowNewAssessmentConfirm(false)}
        />
      )}

      {/* Completion Toast */}
      {showCompletionToast && (
        <div className="completion-toast">
          <div className="completion-toast-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div className="completion-toast-content">
            <h3 className="completion-toast-title">Great job! You completed today's supplement plan.</h3>
            <p className="completion-toast-subtitle">Your adherence and streak have been updated.</p>
          </div>
          <button className="completion-toast-close" onClick={() => setShowCompletionToast(false)}>
            ✕
          </button>
        </div>
      )}

      {/* Mark Taken Toast */}
      {showMarkTakenToast && (
        <Toast 
          message="Supplement marked as taken" 
          type="success" 
          duration={2000}
          onClose={() => setShowMarkTakenToast(false)}
        />
      )}

      <div className="dashboard-container">
        {/* Welcome Section */}
        <div className="dashboard-welcome">
          <h1 className="dashboard-title">Welcome{userData.firstName ? `, ${userData.firstName}` : ''}!</h1>
          <p className="dashboard-subtitle">
            {todaysSupplements.length > 0 || wellnessScore > 0
              ? "Here's your personalized wellness dashboard"
              : "Get started by taking a quick health assessment to receive personalized supplement recommendations"}
          </p>
        </div>

        {/* Action Cards */}
        <div className="dashboard-cards">
          <div className="dashboard-card card-green" onClick={() => navigateToCard('assessment')}>
            <div className="card-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                <path d="M9 14l2 2 4-4"/>
              </svg>
            </div>
            <h3 className="card-title">New Assessment</h3>
          </div>

          <div className="dashboard-card card-blue" onClick={() => navigateToCard('recommendations')}>
            <div className="card-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
            </div>
            <h3 className="card-title">Recommendations</h3>
          </div>

          <div className="dashboard-card card-purple" onClick={() => navigateToCard('track')}>
            <div className="card-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
                <line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </div>
            <h3 className="card-title">Track Intake</h3>
          </div>

          <div className="dashboard-card card-pink" onClick={() => navigateToCard('insights')}>
            <div className="card-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
                <polyline points="16 7 22 7 22 13"/>
              </svg>
            </div>
            <h3 className="card-title">Insights</h3>
          </div>
        </div>

        {/* Bottom Section */}
        <div className="dashboard-bottom">
          {/* Today's Supplements */}
          <div className="dashboard-section supplements-section">
            <div className="section-header-with-legend">
              <h2 className="section-title">Today's Supplements</h2>
              <div className="priority-legend">
                <span className="legend-label">Priority:</span>
                <span className="legend-item">
                  <svg width="6" height="6" viewBox="0 0 24 24" fill="#10b981">
                    <circle cx="12" cy="12" r="12"/>
                  </svg>
                  High
                </span>
                <span className="legend-item">
                  <svg width="6" height="6" viewBox="0 0 24 24" fill="#f59e0b">
                    <circle cx="12" cy="12" r="12"/>
                  </svg>
                  Medium
                </span>
                <span className="legend-item">
                  <svg width="6" height="6" viewBox="0 0 24 24" fill="#6b7280">
                    <circle cx="12" cy="12" r="12"/>
                  </svg>
                  Low
                </span>
              </div>
            </div>
            {todaysSupplements.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {wellnessScore === 0 ? (
                      <>
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                        <line x1="16" y1="2" x2="16" y2="6"/>
                        <line x1="8" y1="2" x2="8" y2="6"/>
                        <line x1="3" y1="10" x2="21" y2="10"/>
                      </>
                    ) : (
                      <>
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                      </>
                    )}
                  </svg>
                </div>
                <p className="empty-state-title">
                  {wellnessScore === 0 
                    ? "No Supplement Plan Yet" 
                    : "You haven't added any supplements to your plan yet."}
                </p>
                <p className="empty-state-subtitle">
                  {wellnessScore === 0
                    ? "Complete a health assessment and add your recommended supplements to your plan to view today's supplements."
                    : "Browse AI recommendations and add supplements to start tracking."}
                </p>
                <button 
                  className="btn-go-recommendations" 
                  onClick={() => navigate(wellnessScore === 0 ? '/assessment' : '/recommendations')}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {wellnessScore === 0 ? (
                      <>
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                        <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                        <path d="M9 14l2 2 4-4"/>
                      </>
                    ) : (
                      <>
                        <path d="M12 2a10 10 0 0 1 7.94 16.06L12 22l-7.94-3.94A10 10 0 0 1 12 2z"/>
                        <circle cx="12" cy="11" r="3"/>
                      </>
                    )}
                  </svg>
                  {wellnessScore === 0 ? 'Take Assessment' : 'Go to AI Recommendations'}
                </button>
              </div>
            ) : (
              <div className="supplements-list">
                {todaysSupplements.map((supplement) => (
                  <div key={supplement.id} className={`supplement-item ${supplement.taken ? 'taken' : ''}`}>
                    <div className="supplement-info">
                      <div className="supplement-header">
                        {supplement.priority && (
                          <span 
                            className={`priority-indicator priority-${supplement.priority.toLowerCase()}`}
                            title={`${supplement.priority} Priority`}
                          >
                            <svg width="6" height="6" viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="12" cy="12" r="12"/>
                            </svg>
                          </span>
                        )}
                        <h4 className="supplement-name">{supplement.name}</h4>
                        {supplement.taken && (
                          <span className="taken-badge">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                            taken
                          </span>
                        )}
                      </div>
                      <p className="supplement-details">
                        {supplement.dosage} - {supplement.scheduledTime}
                      </p>
                      <p className="supplement-time">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/>
                          <polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {supplement.taken 
                          ? `Taken at ${new Date(supplement.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                          : `Best Time: ${supplement.scheduledTime}`
                        }
                      </p>
                    </div>
                    {supplement.taken ? (
                      <button 
                        className="supplement-btn btn-undo"
                        onClick={() => handleSupplementToggle(supplement.id)}
                      >
                        Undo
                      </button>
                    ) : (
                      <button 
                        className="supplement-btn btn-mark-taken"
                        onClick={() => handleSupplementToggle(supplement.id)}
                      >
                        Mark Taken
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right Column */}
          <div className="dashboard-right-column">
            {/* Wellness Score */}
            <div className="dashboard-section score-section">
              <div className="section-title-with-info">
                <h2 className="section-title">Wellness Score</h2>
                <div className="info-icon-wrapper">
                  <button 
                    className="info-icon-btn" 
                    title="How is this calculated?"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="16" x2="12" y2="12"/>
                      <line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                  </button>
                  
                  {/* Hover Tooltip */}
                  <div className="wellness-info-tooltip">
                    <h4 className="wellness-info-title">How Wellness Score Works</h4>
                    <div className="wellness-info-breakdown">
                      <div className="wellness-info-item">
                        <strong>🎯 Health Baseline (0-30)</strong>
                        <p>AI analyzes your assessment to determine your starting health state.</p>
                      </div>
                      <div className="wellness-info-item">
                        <strong>📊 Adherence (0-50)</strong>
                        <p>Your supplement adherence percentage contributes up to 50 points.</p>
                      </div>
                      <div className="wellness-info-item">
                        <strong>🔥 Streak Bonus (0-20)</strong>
                        <p>Maintaining a daily streak contributes up to 20 points.</p>
                      </div>
                    </div>
                    <p className="wellness-info-note">
                      <strong>Max: 100</strong> — Your score grows as you stay consistent!
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="score-display">
                <div className="score-number">{wellnessScore}</div>
                <div className="score-bar">
                  <div
                    className="score-fill"
                    style={{ width: `${wellnessScore}%` }}
                  ></div>
                </div>
              </div>
            </div>

            {/* Quick Stats */}
            <div className="dashboard-section stats-section">
              <h2 className="section-title">Quick Stats</h2>
              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-icon-box">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                      <line x1="16" y1="2" x2="16" y2="6"/>
                      <line x1="8" y1="2" x2="8" y2="6"/>
                      <line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                  </div>
                  <div className="stat-content">
                    <p className="stat-label">Streak</p>
                    <p className="stat-value">
                      {quickStats.daysStreak === 0 
                        ? 'None' 
                        : quickStats.daysStreak === 1 
                          ? '1 Day' 
                          : `${quickStats.daysStreak} Days`
                      }
                    </p>
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-icon-box">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                  </div>
                  <div className="stat-content">
                    <p className="stat-label">Adherence rate</p>
                    <p className="stat-value">{quickStats.adherenceRate}%</p>
                  </div>
                </div>
                <div className="stat-item">
                  <div className="stat-icon-box">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                  </div>
                  <div className="stat-content">
                    <p className="stat-label">Today's Progress</p>
                    <p className="stat-value">{quickStats.todaysProgress.taken}/{quickStats.todaysProgress.total}</p>
                  </div>
                  {quickStats.todaysProgress.taken === quickStats.todaysProgress.total && quickStats.todaysProgress.total > 0 && (
                    <div className="stat-check-icon">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
