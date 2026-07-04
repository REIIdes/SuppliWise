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
  const [weeklyAdherence, setWeeklyAdherence] = useState({
    percentage: 0,
    days: [],
  });
  const [streak, setStreak] = useState(0);
  const [longestStreak, setLongestStreak] = useState(0);
  const [adherenceRate, setAdherenceRate] = useState(0);
  const [completionData, setCompletionData] = useState({});
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const [showMarkTakenToast, setShowMarkTakenToast] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }

    fetchTrackingData();
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
        setError('No assessment found. Please complete an assessment to track your supplements.');
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
          setShowCompletionToast(true);
          // Auto-hide after 4 seconds
          setTimeout(() => setShowCompletionToast(false), 4000);
        } else {
          // Show small toast when marking as taken (but not completed all)
          setShowMarkTakenToast(true);
          setTimeout(() => setShowMarkTakenToast(false), 2000);
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

  if (error) {
    return (
      <div className="track-intake-wrapper">
        <Navbar />
        <div className="track-intake-container">
          <div className="track-intake-error">
            <p>{error}</p>
            <button onClick={() => navigate('/assessment')} className="btn-primary">
              Take Assessment
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
                  <p>No supplements scheduled for today.</p>
                  <p>Complete an assessment to get your personalized plan.</p>
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
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8" y1="2" x2="8" y2="6"/>
                    <line x1="3" y1="10" x2="21" y2="10"/>
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
                      ? 'No Record Yet' 
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
