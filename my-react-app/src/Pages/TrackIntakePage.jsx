import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import { getDashboard, updateIntake, getCalendarData, getWeeklyAdherence } from '../api';
import './TrackIntakePage.css';

function TrackIntakePage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [todaysSupplements, setTodaysSupplements] = useState([]);
  const [hasAssessment, setHasAssessment] = useState(false);
  const [weeklyAdherence, setWeeklyAdherence] = useState({
    percentage: 0,
    days: [],
  });
  const [streak, setStreak] = useState(0);
  const [longestStreak, setLongestStreak] = useState(0);
  const [adherenceRate, setAdherenceRate] = useState(0);
  const [completionData, setCompletionData] = useState({});
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const [markTakenToastMessage, setMarkTakenToastMessage] = useState('');
  const [markTakenToastKey, setMarkTakenToastKey] = useState(0);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }

    fetchTrackingData();

    // Add resize listener for responsive toast
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [navigate]);

  useEffect(() => {
    // Fetch calendar data whenever the displayed month changes
    fetchCalendarData();
  }, [currentDate]);

  const fetchCalendarData = async () => {
    try {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1; // JavaScript months are 0-indexed
      const data = await getCalendarData(year, month);
      setCompletionData(data.completionData || {});
    } catch (err) {
      console.error('Error fetching calendar data:', err);
      // Don't show error to user for calendar data, just fail silently
      setCompletionData({});
    }
  };

  const fetchTrackingData = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await getDashboard();

      if (!data.hasAssessment) {
        // Set empty state for new users without assessment
        setHasAssessment(false);
        setTodaysSupplements([]);
        setStreak(0);
        setLongestStreak(0);
        setAdherenceRate(0);
        setWeeklyAdherence({ percentage: 0, days: [] });
        setLoading(false);
        return;
      }

      setHasAssessment(true);

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
      setStreak(data.stats.daysStreak || 0);
      setLongestStreak(data.stats.longestStreak || 0);
      setAdherenceRate(data.stats.adherenceRate || 0);

      // Fetch real weekly adherence data
      try {
        const weeklyData = await getWeeklyAdherence();
        setWeeklyAdherence({
          percentage: weeklyData.overallAdherence || 0,
          days: weeklyData.weeklyDays || [],
        });
      } catch (err) {
        console.error('Error fetching weekly adherence:', err);
        // Fall back to adherence rate from dashboard if weekly fetch fails
        setWeeklyAdherence({
          percentage: data.stats.adherenceRate || 0,
          days: [],
        });
      }

      setLoading(false);
    } catch (err) {
      console.error('Error fetching tracking data:', err);
      setError(err.message || 'Failed to load tracking data.');
      setLoading(false);
    }
  };

  const handleMarkTaken = async (supplementId) => {
    const supplement = todaysSupplements.find(s => s.id === supplementId);
    if (!supplement) return;

    // Optimistically update UI
    setTodaysSupplements(prev => {
      const updated = prev.map(sup =>
        sup.id === supplementId
          ? { ...sup, taken: true, takenAt: new Date() }
          : sup
      );
      // Sort by taken status first, then schedule time, then priority
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
      const result = await updateIntake(supplementId, true);
      
      if (result.stats) {
        setStreak(result.stats.daysStreak);
        setAdherenceRate(result.stats.overallAdherence);
        setWeeklyAdherence(prev => ({
          ...prev,
          percentage: result.stats.overallAdherence,
        }));
        
        // Check if all supplements are now taken
        if (result.stats.todaysProgress.taken === result.stats.todaysProgress.total && 
            result.stats.todaysProgress.total > 0) {
          // Hide the "marked as taken" toast immediately
          setMarkTakenToastMessage('');
          // Show completion toast
          setShowCompletionToast(true);
          // Auto-hide after 4 seconds
          setTimeout(() => setShowCompletionToast(false), 4000);
        } else {
          // Show toast when marking as taken (but not completed all)
          // Increment key to force re-render even if previous toast is still showing
          setMarkTakenToastKey(prev => prev + 1);
          setMarkTakenToastMessage('Supplement marked as taken');
        }
      }
    } catch (err) {
      console.error('Error marking supplement as taken:', err);
      // Revert on error
      setTodaysSupplements(prev =>
        prev.map(sup =>
          sup.id === supplementId ? { ...sup, taken: false, takenAt: null } : sup
        )
      );
    }
  };

  const handleUndoTaken = async (supplementId) => {
    const supplement = todaysSupplements.find(s => s.id === supplementId);
    if (!supplement) return;

    // Optimistically update UI
    setTodaysSupplements(prev => {
      const updated = prev.map(sup =>
        sup.id === supplementId
          ? { ...sup, taken: false, takenAt: null }
          : sup
      );
      // Sort by taken status first, then schedule time, then priority
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
      const result = await updateIntake(supplementId, false);
      
      if (result.stats) {
        setStreak(result.stats.daysStreak);
        setAdherenceRate(result.stats.overallAdherence);
        setWeeklyAdherence(prev => ({
          ...prev,
          percentage: result.stats.overallAdherence,
        }));
      }
    } catch (err) {
      console.error('Error undoing supplement:', err);
      // Revert on error
      setTodaysSupplements(prev =>
        prev.map(sup =>
          sup.id === supplementId ? { ...sup, taken: true, takenAt: supplement.takenAt } : sup
        )
      );
    }
  };

  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const days = [];
    // Empty cells for days before month starts
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="calendar-day empty"></div>);
    }
    
    // Actual days
    const today = new Date();
    for (let day = 1; day <= daysInMonth; day++) {
      const isToday = day === today.getDate() && 
                      month === today.getMonth() && 
                      year === today.getFullYear();
      
      // Check completion status for this day
      const dayData = completionData[day];
      let dayClass = '';
      let tooltipText = '';
      
      if (isToday) {
        dayClass = 'today';
        tooltipText = 'Today';
      } else if (dayData) {
        if (dayData.percentage === 100) {
          dayClass = 'completed';
          tooltipText = `${dayData.taken}/${dayData.total} supplements taken (100%)`;
        } else if (dayData.percentage > 0) {
          dayClass = 'partial';
          tooltipText = `${dayData.taken}/${dayData.total} supplements taken (${dayData.percentage}%)`;
        } else {
          dayClass = 'missed';
          tooltipText = `${dayData.taken}/${dayData.total} supplements taken (0%)`;
        }
      }
      
      days.push(
        <div 
          key={day} 
          className={`calendar-day ${dayClass}`}
          title={tooltipText}
        >
          {day}
          {dayData && dayData.percentage === 100 && (
            <svg 
              className="completion-checkmark" 
              width="12" 
              height="12" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="3" 
              strokeLinecap="round" 
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </div>
      );
    }
    
    return days;
  };

  const goToPreviousMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  if (loading) {
    return (
      <div className="track-intake-wrapper">
        <Navbar />
        <div className="track-intake-loading-simple">
          <div className="loading-spinner-simple"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="track-intake-wrapper">
        <Navbar />
        <div className="track-intake-container">
          <div className="track-intake-error">
            <p>{error}</p>
            <button onClick={() => navigate('/assessment')} className="btn-primary">
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="track-intake-wrapper">
      <Navbar />

      {/* Completion Toast */}
      {showCompletionToast && (
        <div 
          style={{
            position: 'fixed',
            top: isMobile ? '90px' : '24px',
            right: isMobile ? '12px' : '24px',
            left: isMobile ? '12px' : 'auto',
            width: isMobile ? 'auto' : '420px',
            background: 'linear-gradient(135deg, #6ee7b7 0%, #3dbf8a 100%)',
            borderRadius: '16px',
            padding: isMobile ? '16px' : '20px 24px',
            boxShadow: '0 10px 40px rgba(61, 191, 138, 0.4)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '16px',
            zIndex: 1001,
            boxSizing: 'border-box',
            animation: 'slideInRight 0.4s ease-out'
          }}
        >
          <div style={{ 
            flexShrink: 0, 
            width: isMobile ? '36px' : '40px', 
            height: isMobile ? '36px' : '40px',
            background: 'rgba(255, 255, 255, 0.3)',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white'
          }}>
            <svg width={isMobile ? "20" : "24"} height={isMobile ? "20" : "24"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ 
              margin: '0 0 6px 0', 
              fontSize: isMobile ? '14px' : '16px',
              fontWeight: 700,
              color: 'white',
              lineHeight: '1.4'
            }}>
              Great job! You completed today's supplement plan.
            </h3>
            <p style={{ 
              margin: 0, 
              fontSize: isMobile ? '12px' : '14px',
              color: 'rgba(255, 255, 255, 0.9)',
              lineHeight: '1.4'
            }}>
              Your adherence and streak have been updated.
            </p>
          </div>
          <button 
            style={{ 
              flexShrink: 0,
              background: 'rgba(255, 255, 255, 0.2)',
              border: 'none',
              width: '28px',
              height: '28px',
              borderRadius: isMobile ? '6px' : '50%',
              color: 'white',
              fontSize: '16px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              lineHeight: 1,
              transition: 'all 0.2s ease'
            }} 
            onClick={() => setShowCompletionToast(false)}
            onMouseEnter={(e) => e.target.style.background = 'rgba(255, 255, 255, 0.3)'}
            onMouseLeave={(e) => e.target.style.background = 'rgba(255, 255, 255, 0.2)'}
          >
            ✕
          </button>
        </div>
      )}

      {/* Mark Taken Toast */}
      {markTakenToastMessage && (
        <Toast 
          key={markTakenToastKey}
          message={markTakenToastMessage} 
          type="success" 
          duration={2000}
          onClose={() => setMarkTakenToastMessage('')}
        />
      )}
      
      <div className="track-intake-container">
        {/* Header */}
        <div className="track-intake-header">
          <h1 className="track-intake-title">Supplement Tracker</h1>
          <p className="track-intake-subtitle">Track your daily supplement intake from your active assessment</p>
        </div>

        <div className="track-intake-content">
          {/* Left Column */}
          <div className="track-intake-left">
            {/* Today's Supplements */}
            <div className="track-section">
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
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 16px', color: '#10b981' }}>
                    {hasAssessment ? (
                      <>
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                      </>
                    ) : (
                      <>
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                        <line x1="16" y1="2" x2="16" y2="6"/>
                        <line x1="8" y1="2" x2="8" y2="6"/>
                        <line x1="3" y1="10" x2="21" y2="10"/>
                      </>
                    )}
                  </svg>
                  <p style={{ fontSize: '18px', marginBottom: '8px', color: '#111827', fontWeight: '700' }}>
                    {hasAssessment 
                      ? "You haven't added any supplements to your plan yet." 
                      : "No Supplement Plan Yet"}
                  </p>
                  <p style={{ color: '#6b7280', marginBottom: '16px' }}>
                    {hasAssessment
                      ? 'Browse AI recommendations and add supplements to start tracking.'
                      : 'Complete a health assessment and add your recommended supplements to your plan to view today\'s supplements.'}
                  </p>
                  <button 
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 20px',
                      backgroundColor: '#10b981',
                      color: 'white',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: '600',
                      cursor: 'pointer',
                      transition: 'background-color 0.2s'
                    }}
                    onClick={() => navigate(hasAssessment ? '/recommendations' : '/assessment')}
                    onMouseOver={(e) => e.target.style.backgroundColor = '#059669'}
                    onMouseOut={(e) => e.target.style.backgroundColor = '#10b981'}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {hasAssessment ? (
                        <>
                          <path d="M12 2a10 10 0 0 1 7.94 16.06L12 22l-7.94-3.94A10 10 0 0 1 12 2z"/>
                          <circle cx="12" cy="11" r="3"/>
                        </>
                      ) : (
                        <>
                          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                          <path d="M9 14l2 2 4-4"/>
                        </>
                      )}
                    </svg>
                    {hasAssessment ? 'Go to AI Recommendations' : 'Take Assessment'}
                  </button>
                </div>
              ) : (
                <div className="supplements-list">
                  {todaysSupplements.map((supplement) => (
                    <div key={supplement.id} className={`supplement-card ${supplement.taken ? 'taken' : ''}`}>
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
                          <h3 className="supplement-name">{supplement.name}</h3>
                          {supplement.taken && (
                            <span className="taken-badge">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                              taken
                            </span>
                          )}
                        </div>
                        <p className="supplement-dosage">{supplement.dosage}</p>
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
                          className="btn-undo"
                          onClick={() => handleUndoTaken(supplement.id)}
                        >
                          Undo
                        </button>
                      ) : (
                        <button 
                          className="btn-mark-taken"
                          onClick={() => handleMarkTaken(supplement.id)}
                        >
                          Mark taken
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* This Week's Adherence */}
            <div className="track-section">
              <h2 className="section-title">Overall Adherence</h2>
              <div className="adherence-box">
                <div className="adherence-message">
                  <strong>{weeklyAdherence.percentage}% adherence</strong> overall! {weeklyAdherence.percentage >= 80 ? "You're doing great at maintaining your routine." : "Keep going, consistency is key!"}
                </div>
                {weeklyAdherence.days.length > 0 && (
                  <div className="adherence-days">
                    {weeklyAdherence.days.map((day, index) => (
                      <div key={index} className="adherence-day">
                        <span className="day-name">{day.day}</span>
                        <span className="day-count">{day.completed}/{day.total}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="track-intake-right">
            {/* Calendar */}
            <div className="track-section calendar-section">
              <h2 className="section-title">Calendar</h2>
              <div className="calendar-header">
                <button className="calendar-nav-btn" onClick={goToPreviousMonth}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"/>
                  </svg>
                </button>
                <span className="calendar-month">{monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}</span>
                <button className="calendar-nav-btn" onClick={goToNextMonth}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </button>
              </div>
              <div className="calendar-weekdays">
                <div className="weekday">Su</div>
                <div className="weekday">Mo</div>
                <div className="weekday">Tu</div>
                <div className="weekday">We</div>
                <div className="weekday">Th</div>
                <div className="weekday">Fr</div>
                <div className="weekday">Sa</div>
              </div>
              <div className="calendar-grid">
                {renderCalendar()}
              </div>
              <div className="calendar-legend">
                <div className="legend-item">
                  <div className="legend-color today-color"></div>
                  <span>Today</span>
                </div>
                <div className="legend-item">
                  <div className="legend-color completed-color"></div>
                  <span>100%</span>
                </div>
                <div className="legend-item">
                  <div className="legend-color partial-color"></div>
                  <span>Partial</span>
                </div>
                <div className="legend-item">
                  <div className="legend-color missed-color"></div>
                  <span>Missed</span>
                </div>
              </div>
            </div>

            {/* Streak */}
            <div className="track-section streak-section">
              <div className="streak-content">
                <div className="streak-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
                  </svg>
                </div>
                <div className="streak-text">
                  <span className="streak-number">
                    {streak === 0 
                      ? 'No Active Streak' 
                      : streak === 1 
                        ? '1 Day Streak' 
                        : `${streak} Day Streak`
                    }
                  </span>
                  <p className="streak-subtitle">
                    {streak === 0 
                      ? 'Take all supplements today to start your streak!' 
                      : 'Perfect days in a row'}
                  </p>
                </div>
              </div>
            </div>

            {/* Longest Streak */}
            <div className="track-section streak-section">
              <div className="streak-content">
                <div className="streak-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
                    <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
                    <path d="M4 22h16"/>
                    <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
                    <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
                    <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
                  </svg>
                </div>
                <div className="streak-text">
                  <span className="streak-number">
                    {longestStreak === 0 
                      ? '0 Days' 
                      : longestStreak === 1 
                        ? '1 Day' 
                        : `${longestStreak} Days`
                    }
                  </span>
                  <p className="streak-subtitle">
                    {longestStreak === 0 
                      ? 'Complete a day to set your record!' 
                      : 'Longest Streak'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TrackIntakePage;
