import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import { getDashboard, updateIntake, updateIntakeBulk, getCalendarData, getWeeklyAdherence, getDayRecords, getToken } from '../api';
import './TrackIntakePage.css';

/* Priority → tone modifier. `low` is the floor so a row with no priority
   is styled as the least-prominent thing rather than as high by accident. */
const PRIORITY_TONES = { high: 'high', medium: 'medium', low: 'low' };
const priorityTone = (priority) => PRIORITY_TONES[String(priority || '').toLowerCase()] || 'low';

/* Grouping today's plan by part of day, plus the sort order — see
   utils/timeSlots.js for why the server's slot is trusted over the free-text
   timing and why the sections have a fixed order. The time windows each section
   opens and closes at live in utils/slotSchedule.js. */
import { groupBySlot, pendingIds, sortPlan } from '../utils/timeSlots.js';
import { layoutPlan, isTakenLate, isDeadHour, DEAD_HOURS } from '../utils/slotSchedule.js';
/* The running PLAN DAY (04:00 → 04:00, in the user's own zone), which is not the
   calendar date for four hours out of every eight — see utils/planDay.js. The
   server names it in every response, and `usePlanDay` watches for it changing so a
   page left open across the reset refetches instead of showing yesterday's
   finished plan. */
import usePlanDay from '../hooks/usePlanDay.js';

/* Section icons. Inline SVG rather than emoji so they inherit `currentColor`
   and stay legible next to the priority dots. */
const SLOT_ICONS = {
  morning: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  afternoon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v3M5.6 5.6l2.1 2.1M2 12h3M5.6 18.4l2.1-2.1" />
      <path d="M9 17a5 5 0 0 1 10 0z" />
    </svg>
  ),
  evening: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 18a7 7 0 0 1-10-11.7A7 7 0 0 0 17 18z" />
    </svg>
  ),
  night: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  ),
  anytime: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
};

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
  const [completionData, setCompletionData] = useState({});
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const [priorityLifted, setPriorityLifted] = useState(false);
  const [markTakenToastMessage, setMarkTakenToastMessage] = useState('');
  const [markTakenToastKey, setMarkTakenToastKey] = useState(0);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  // Which time slot has a bulk request in flight, so its button can show
  // progress and refuse a second press instead of double-submitting.
  const [slotPending, setSlotPending] = useState(null);

  // Interactive calendar: selected past day + its records (read-only history)
  const [selectedDay, setSelectedDay] = useState(null); // 'YYYY-MM-DD' or null (= today)
  const [dayRecords, setDayRecords] = useState([]);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState('');

  // The day the plan belongs to. The server names it; `usePlanDay` resolves it and
  // watches for the rollover. It used to be built here from `new Date()`'s
  // year/month/day — the CALENDAR date, which is the previous calendar date for
  // four hours out of every eight, so this page and the server disagreed about
  // which rows were editable.
  const [planDayKey, setPlanDayKey] = useState('');

  // Morning / Afternoon / Evening sections, in fixed order. Memoised so the
  // grouping is computed once per plan change rather than on every render.
  const slotGroups = useMemo(() => groupBySlot(todaysSupplements), [todaysSupplements]);

  /* The clock the time windows are judged against.
     A window that closes while the page sits open would otherwise stay tickable
     until the user reloaded — so this re-renders on a timer, and immediately on
     wake (a laptop asleep across a window boundary must not come back showing a
     stale, unlocked section). 30s is fine: the boundaries are on the hour and
     half-hour, so the worst case is half a minute of lag on an already-due
     change, and nothing is lost by being late to *hide* a window. */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const interval = setInterval(tick, 30_000);
    const onWake = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', tick);
    };
  }, []);

  /* The page, laid out for the current moment: the one open frame, Anytime, and
     the tray of doses whose window has closed. Decided in utils/slotSchedule.js
     so the dashboard cannot disagree with this page about what is on screen. */
  const plan = useMemo(() => layoutPlan(slotGroups, now), [slotGroups, now]);

  // The dead hours close the assessment action here too, not just on the form.
  const deadHours = isDeadHour(now);

  const loadDay = async (key) => {
    setSelectedDay(key);
    setDayRecords([]);
    setDayError('');
    setDayLoading(true);
    try {
      const data = await getDayRecords(key);
      setDayRecords(data.records || []);
    } catch (err) {
      setDayError(err.message || 'Could not load that day.');
    } finally {
      setDayLoading(false);
    }
  };

  const handleDayClick = (day) => {
    const key = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    // Resolved against the PLAN DAY, so the live day and the "future" days are one
    // decision. They used to come from two different dates — a cell could be marked
    // "today" by one and refused as history by the other.
    if (key >= todayKey) {
      setSelectedDay(null);
      setDayRecords([]);
      setDayError('');
      return;
    }
    // Toggle off when clicking the already-selected day
    if (selectedDay === key) {
      setSelectedDay(null);
      setDayRecords([]);
      setDayError('');
      return;
    }
    loadDay(key);
  };

  const fetchCalendarData = useCallback(async () => {
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
  }, [currentDate]);

  const fetchTrackingData = useCallback(async () => {
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
        setWeeklyAdherence({ percentage: 0, days: [] });
        setLoading(false);
        return;
      }

      setHasAssessment(true);

      // Adopt the server's day BEFORE anything reads it, so the calendar and the
      // "is this today?" checks below are rendered against the same day the doses
      // were loaded for.
      setPlanDayKey(data.planDay?.todayKey || '');
      setTodaysSupplements(sortPlan(data.todaysSupplements || []));
      setStreak(data.stats.daysStreak || 0);
      setLongestStreak(data.stats.longestStreak || 0);

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
  }, []);

  // Initial load on mount + auth guard + responsive toast
  useEffect(() => {
    const token = getToken();
    if (!token) {
      navigate('/login');
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial tracking load on mount
    fetchTrackingData();

    // Add resize listener for responsive toast
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    // Realtime: refresh the moment the user returns to the tab
    const handleVisible = () => {
      if (document.visibilityState === 'visible' && getToken()) {
        fetchTrackingData();
        fetchCalendarData();
      }
    };
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  useEffect(() => {
    // Fetch calendar data whenever the displayed month changes
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional refetch on month change
    fetchCalendarData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDate]);

  /* Watch the plan day. When it rolls over, everything above is yesterday's —
     so refetch rather than leaving a finished plan on screen until the user
     reloads by hand. Armed only once there is a plan to roll over INTO.
     `usePlanDay` returns the day to render: the server's once it has answered,
     and the local rule until then. */
  const onPlanDayReset = useCallback(() => {
    fetchTrackingData();
    fetchCalendarData();
  }, [fetchTrackingData, fetchCalendarData]);
  const todayKey = usePlanDay(planDayKey, onPlanDayReset, { enabled: todaysSupplements.length > 0 });


  /* Shared post-update bookkeeping for both the single tick and the bulk tick.
     Returns the server stats so each caller can react to completion itself. */
  const applyIntakeResult = async (result, { onLift } = {}) => {
    if (!result?.stats) return;
    setStreak(result.stats.daysStreak);
    setWeeklyAdherence(prev => ({ ...prev, percentage: result.stats.overallAdherence }));

    const { taken, total } = result.stats.todaysProgress;
    if (taken === total && total > 0) {
      // Hide the "marked as taken" toast immediately
      setMarkTakenToastMessage('');
      // Flag auto-lifted when the last supplement completed the plan
      setPriorityLifted(!!result.priorityLifted);
      setShowCompletionToast(true);
      setTimeout(() => setShowCompletionToast(false), 4000);
    } else {
      // Increment key to force re-render even if previous toast is still showing
      setMarkTakenToastKey(prev => prev + 1);
      setMarkTakenToastMessage(onLift || 'Supplement marked as taken');
    }

    // Realtime: refresh calendar colors + weekly stats immediately
    fetchCalendarData();
    try {
      const weeklyData = await getWeeklyAdherence();
      setWeeklyAdherence({
        percentage: weeklyData.overallAdherence || 0,
        days: weeklyData.weeklyDays || [],
      });
    } catch {
      // Weekly panel keeps previous values on failure
    }
  };

  const handleMarkTaken = async (supplementId) => {
    const supplement = todaysSupplements.find(s => s.id === supplementId);
    if (!supplement || supplement.taken) return;

    // Optimistic update UI
    setTodaysSupplements(prev => sortPlan(prev.map(sup =>
      sup.id === supplementId
        ? { ...sup, taken: true, takenAt: new Date() }
        : sup
    )));

    try {
      const result = await updateIntake(supplementId, true);
      await applyIntakeResult(result);
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

  /* One press for a whole time slot. The server does the write as a single
     update, so the streak, adherence and priority bookkeeping see one final
     state instead of N intermediate ones — pressing "Mark Morning taken" five
     times could otherwise award and then revoke the day-complete streak five
     times on the way through. */
  const handleMarkSlotTaken = async (groupKey) => {
    const group = slotGroups.find(g => g.key === groupKey);
    if (!group) return;
    const ids = pendingIds(group.items);
    if (ids.length === 0) return;

    // Snapshot the rows being changed so a failure can restore exactly what
    // was there, rather than assuming they were all untaken.
    const previous = todaysSupplements.filter(sup => ids.includes(sup.id));
    const takenAt = new Date();

    setSlotPending(groupKey);
    setTodaysSupplements(prev => sortPlan(prev.map(sup =>
      ids.includes(sup.id) ? { ...sup, taken: true, takenAt } : sup
    )));

    try {
      const result = await updateIntakeBulk(ids, true);
      await applyIntakeResult(
        result,
        { onLift: `${ids.length} ${group.label.toLowerCase()} supplements marked as taken` }
      );
    } catch (err) {
      console.error('Error marking time slot as taken:', err);
      // Revert the whole slot, so the UI never claims a tick the server refused
      setTodaysSupplements(prev => {
        const restored = new Map(previous.map(sup => [sup.id, sup]));
        return prev.map(sup => restored.get(sup.id) ?? sup);
      });
      setMarkTakenToastKey(prev => prev + 1);
      setMarkTakenToastMessage('Could not update those supplements. Please try again.');
    } finally {
      setSlotPending(null);
    }
  };

  /* One supplement row. Extracted so the active frame and the missed tray show
     the SAME card — they used to be separate inline blocks, which is how a
     "Taken" pill ends up on one and a "Mark as Taken" button on the other for
     identical data. */
  const renderRow = (supplement, { missed = false, locked = false, slotKey = '' } = {}) => {
    const isTaken = !!supplement.taken;
    // Judged against the row's OWN window, from its timestamp — not against the
    // clock now. A dose recorded at 1:03 AM for a 10 PM slot reads "Took it
    // Late" even when it is looked at again at lunchtime.
    const late = isTaken && isTakenLate(supplement, slotKey || supplement.missedSlot);
    const timeText = isTaken
      ? `Taken at ${new Date(supplement.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${late ? ' · late' : ''}`
      : `Best Time: ${supplement.scheduleTime || supplement.scheduledTime}`;

    return (
      <div
        key={supplement.id}
        className={[
          'supplement-card',
          `supplement-card--${priorityTone(supplement.priority)}`,
          isTaken ? 'taken' : '',
          !isTaken && missed ? 'supplement-card--missed' : '',
          !isTaken && locked ? 'supplement-card--locked' : '',
        ].filter(Boolean).join(' ')}
      >
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
            {isTaken ? (
              <span className="taken-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                taken
              </span>
            ) : missed ? (
              <span className="missed-badge">Missed</span>
            ) : null}
          </div>
          <p className="supplement-dosage">{supplement.dosage}</p>
          <p className="supplement-time">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            {timeText}
          </p>
        </div>
        {/* No Undo button by request. A read-only "Taken" pill takes its place
            so the row does not end in empty space and the state is legible. */}
        {isTaken ? (
          late ? (
            // Amber, not green. Green reads as "done, on time", which is exactly
            // what a late dose is not.
            <span className="supplement-late-pill">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              Took it Late
            </span>
          ) : (
            <span className="supplement-taken-pill">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Taken
            </span>
          )
        ) : locked ? (
          // The dead hours ended the day. Saying "Locked" is more honest than
          // leaving a button that silently does nothing.
          <span className="supplement-locked-pill">Locked</span>
        ) : (
          <button
            className="btn-mark-taken"
            onClick={() => handleMarkTaken(supplement.id)}
            disabled={slotPending !== null}
          >
            {missed ? 'Took it late' : 'Mark as Taken'}
          </button>
        )}
      </div>
    );
  };

  const renderMissedRow = (supplement, locked) => renderRow(supplement, { missed: true, locked });

  /** One time frame: header with the hours and a take-all, then its rows. */
  const renderFrame = (group, section) => {
    const isPending = slotPending === group.key;
    const isDeadHour = section.isDeadHour;
    return (
      <section
        key={group.key}
        className={[
          'slot-group',
          `slot-group--${group.key}`,
          section.isComplete ? 'slot-group--complete' : '',
          isDeadHour && section.isTickable ? 'slot-group--snoozed' : '',
        ].filter(Boolean).join(' ')}
        aria-labelledby={`slot-${group.key}`}
      >
        <header className="slot-group__header">
          <span className="slot-group__label">
            <span className={`slot-group__icon slot-group__icon--${group.key}`} aria-hidden="true">
              {SLOT_ICONS[group.key]}
            </span>
            <span className="slot-group__names">
              <h3 id={`slot-${group.key}`} className="slot-group__title">{group.label}</h3>
              <span className="slot-group__window">
                {isDeadHour ? `Locked until ${DEAD_HOURS.endsAt}` : section.window}
              </span>
            </span>
          </span>
          <span className="slot-group__meta">
            {isDeadHour && section.isTickable && (
              <span className="slot-group__flag slot-group__flag--night">Locked until {DEAD_HOURS.endsAt}</span>
            )}
            <span className="slot-group__count">{section.taken}/{section.total}</span>
            {section.isComplete ? (
              <span className="slot-group__done">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Done
              </span>
            ) : (
              <button
                type="button"
                className="btn-slot-taken"
                onClick={() => handleMarkSlotTaken(group.key)}
                disabled={isPending}
                aria-label={`Mark all ${group.label.toLowerCase()} supplements as taken`}
              >
                {isPending ? 'Saving…' : isDeadHour ? 'Took it anyway' : `Take all ${group.label.toLowerCase()}`}
              </button>
            )}
          </span>
        </header>
        <div className="supplements-list">
          {group.items.map((supplement) => renderRow(supplement, { slotKey: group.key }))}
        </div>
      </section>
    );
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
    //
    // "Today" is the CELL'S KEY compared to the plan day's key — not a field-by-field
    // match against `new Date()`. That is what lets one key decide today, future and
    // selectable at once; two derivations is how a cell ended up both today and
    // history.
    for (let day = 1; day <= daysInMonth; day++) {
      const cellKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = cellKey === todayKey;
      const isFuture = cellKey > todayKey;
      const isSelected = selectedDay === cellKey;

      // Check completion status for this day
      const dayData = completionData[day];
      let dayClass = '';
      let tooltipText;

      if (isToday) {
        dayClass = 'today';
        tooltipText = 'Today — use the list above';
      } else if (isFuture) {
        dayClass = 'future';
        tooltipText = 'Future date';
      } else if (dayData) {
        if (dayData.percentage === 100) {
          dayClass = 'completed';
          tooltipText = `${dayData.taken}/${dayData.total} supplements taken (100%) — click to view`;
        } else if (dayData.percentage > 0) {
          dayClass = 'partial';
          tooltipText = `${dayData.taken}/${dayData.total} supplements taken (${dayData.percentage}%) — click to view`;
        } else {
          dayClass = 'missed';
          tooltipText = `${dayData.taken}/${dayData.total} supplements taken (0%) — click to view`;
        }
      } else {
        tooltipText = 'No records — click to view';
      }

      days.push(
        <button
          type="button"
          key={day}
          className={`calendar-day ${dayClass}${isSelected ? ' selected' : ''}`}
          title={tooltipText}
          aria-label={`${monthNames[month]} ${day}, ${year}${tooltipText ? ` — ${tooltipText}` : ''}`}
          aria-pressed={isSelected}
          disabled={isFuture}
          onClick={() => handleDayClick(day)}
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
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </button>
      );
    }
    
    return days;
  };

  const goToPreviousMonth = () => {
    setSelectedDay(null);
    setDayRecords([]);
    setDayError('');
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const goToNextMonth = () => {
    setSelectedDay(null);
    setDayRecords([]);
    setDayError('');
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
            <button onClick={() => navigate('/assessment')} className="track-intake-error__btn">
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
              {priorityLifted
                ? 'Priority review completed! New assessments are unlocked.'
                : "Great job! You completed today's supplement plan."}
            </h3>
            <p style={{
              margin: 0,
              fontSize: isMobile ? '12px' : '14px',
              color: 'rgba(255, 255, 255, 0.9)',
              lineHeight: '1.4'
            }}>
              {priorityLifted
                ? 'All supplements taken — the flag on your assessment has been lifted.'
                : 'Your adherence and streak have been updated.'}
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
                    // "Take Assessment" is closed during the dead hours, same as
                    // the form it leads to; "Go to AI Recommendations" is not.
                    disabled={!hasAssessment && deadHours}
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
                <div className="supplements-list supplements-list--slots">
                  {/* DEAD HOURS — every field listed and empty, each with a
                      countdown to when it opens. No rows, no buttons. */}
                  {plan.deadHour && (
                    <>
                      <p className="slots-deadhead">
                        Resting until {DEAD_HOURS.endsAt}. Your plan is ready — nothing to take yet.
                      </p>
                      {plan.placeholders.map(placeholder => (
                        <section
                          key={placeholder.key}
                          className={`slot-group slot-group--${placeholder.key} slot-group--placeholder`}
                          aria-labelledby={`ph-${placeholder.key}`}
                        >
                          <header className="slot-group__header">
                            <span className="slot-group__label">
                              <span className={`slot-group__icon slot-group__icon--${placeholder.key}`} aria-hidden="true">
                                {SLOT_ICONS[placeholder.key]}
                              </span>
                              <span className="slot-group__names">
                                <h3 id={`ph-${placeholder.key}`} className="slot-group__title">{placeholder.label}</h3>
                                {placeholder.window && (
                                  <span className="slot-group__window">{placeholder.window}</span>
                                )}
                              </span>
                            </span>
                            <span className="slot-group__meta">
                              <span className="slot-group__count slot-group__count--quiet">
                                {placeholder.total} waiting
                              </span>
                              <span className="slot-group__countdown">
                                Opens {placeholder.opensAt}
                                {!placeholder.countdown.isDue && ` · in ${placeholder.countdown.text}`}
                              </span>
                            </span>
                          </header>
                        </section>
                      ))}
                    </>
                  )}

                  {/* THE ACTIVE FRAME — the only timed section on the page. */}
                  {!plan.deadHour && plan.active.map(({ group, section }) => renderFrame(group, section))}
                  {!plan.deadHour && plan.active.length === 0 && plan.upcomingCount > 0 && (
                    <p className="slots-idle">
                      Next up: {plan.upcomingCount === 1 ? 'your next time frame' : `${plan.upcomingCount} time frames`} — your plan starts at 4:00 AM.
                    </p>
                  )}

                  {/* ANYTIME — no window, so never hidden, never locked. */}
                  {!plan.deadHour && plan.anytime && renderFrame(plan.anytime.group, plan.anytime.section)}

                  {/* TODAY MISSED — closed windows, parked at the very bottom. */}
                  {!plan.deadHour && plan.missed.total > 0 && (
                    <section className="slot-tray" aria-labelledby="missed-tray-heading">
                      <header className="slot-tray__header">
                        <h3 id="missed-tray-heading" className="slot-tray__title">{plan.missed.title}</h3>
                        <span className="slot-tray__count">{plan.missed.total}</span>
                        <span className="slot-tray__note">Window passed — you can still record these</span>
                      </header>
                      <div className="supplements-list">
                        {plan.missed.items.map((supplement) => renderMissedRow(supplement, false))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>

            {/* Selected-day detail (interactive calendar history, read-only) */}
            {selectedDay && (
              <div className="track-section day-detail">
                <div className="day-detail__header">
                  <h2 className="section-title">
                    {new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                  </h2>
                  <button
                    type="button"
                    className="day-detail__close"
                    onClick={() => { setSelectedDay(null); setDayRecords([]); setDayError(''); }}
                    aria-label="Close day details"
                  >
                    ×
                  </button>
                </div>
                {dayLoading ? (
                  <p className="day-detail__status">Loading that day…</p>
                ) : dayError ? (
                  <div className="day-detail__error" role="alert">
                    <span>{dayError}</span>
                    <button
                      type="button"
                      className="day-detail__retry"
                      onClick={() => selectedDay && loadDay(selectedDay)}
                    >
                      Retry
                    </button>
                  </div>
                ) : dayRecords.length === 0 ? (
                  <p className="day-detail__status">No supplements were on the plan that day.</p>
                ) : (
                  <>
                    <p className="day-detail__summary">
                      {dayRecords.filter(r => r.taken).length} of {dayRecords.length} taken
                      {dayRecords.length > 0 && dayRecords.every(r => r.taken) ? ' — perfect day 🎉' : ''}
                    </p>
                    <div className="day-detail__list">
                      {dayRecords.map(rec => (
                        <div key={rec.id} className={`day-detail__row${rec.taken ? ' day-detail__row--taken' : ''}`}>
                          <span
                            className={`priority-indicator priority-${(rec.priority || 'medium').toLowerCase()}`}
                            title={`${rec.priority} Priority`}
                          >
                            <svg width="6" height="6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                              <circle cx="12" cy="12" r="12" />
                            </svg>
                          </span>
                          <div className="day-detail__info">
                            <span className="day-detail__name">{rec.name}</span>
                            <span className="day-detail__meta">
                              {rec.dosage}
                              {rec.taken && rec.takenAt
                                ? ` · Taken at ${new Date(rec.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                                : ` · Best time: ${rec.scheduledTime}`}
                            </span>
                          </div>
                          <span className={`day-detail__pill${rec.taken ? ' day-detail__pill--taken' : ' day-detail__pill--missed'}`}>
                            {rec.taken ? '✓ Taken' : 'Not taken'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

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
