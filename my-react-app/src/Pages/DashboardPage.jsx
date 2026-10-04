import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import ConfirmModal from '../Components/ConfirmModal/ConfirmModal';
import { getDashboard, updateIntake, updateIntakeBulk, getToken, getStoredUser, getMyProfile, setStoredUser } from '../api';
import { subscribeDashboardRefresh } from '../utils/dashboardRefresh';
import useSubscription from '../hooks/useSubscription';
import useNow from '../hooks/useNow';
import { greetingFor } from '../utils/greeting.js';
/* The running PLAN DAY (04:00 → 04:00, in the user's own zone) — not the calendar
   date, which is the previous calendar date for four hours out of every eight. The
   server names it in every response and `usePlanDay` watches for it changing, so a
   page left open across the reset refetches instead of rendering yesterday's
   finished plan. See utils/planDay.js. */
import usePlanDay from '../hooks/usePlanDay.js';
import './DashboardPage.css';

/* ── Action cards ───────────────────────────────────────────────────────────
   One table, rendered in a loop. These were four hand-copied <div onClick>
   blocks; that is four places to forget the keyboard handler, the icon or the
   blocked state, and it is why they were unreachable by keyboard at all. A
   <div> with an onClick is not a control: it cannot be tabbed to, cannot be
   activated with Enter/Space and is never announced as a button. They are real
   <button>s now, so that all comes for free. */
const ACTION_CARDS = [
  {
    key: 'assessment',
    label: 'New Assessment',
    hint: 'Retake your health check-in',
    tone: 'emerald',
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <path d="M9 14l2 2 4-4" />
      </svg>
    ),
  },
  {
    key: 'recommendations',
    label: 'Recommendations',
    hint: 'AI-picked supplements for you',
    tone: 'azure',
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    key: 'track',
    label: 'Track Intake',
    hint: 'Log and tick off each dose',
    tone: 'violet',
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    key: 'insights',
    label: 'Insights',
    hint: 'Trends in sleep, energy & mood',
    tone: 'rose',
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
        <polyline points="16 7 22 7 22 13" />
      </svg>
    ),
  },
];

/* Grouping today's plan by part of day, plus the shared sort order — see
   utils/timeSlots.js. Both this page and the tracker render the same plan, so
   they must group and order it identically. `takenCount` is deliberately NOT
   imported here: this page already derives its own count for the progress bar,
   and importing a second one would leave two names meaning the same thing. */
import { groupBySlot, pendingIds, sortPlan } from '../utils/timeSlots.js';
import { layoutPlan, isTakenLate, isDeadHour, DEAD_HOURS } from '../utils/slotSchedule.js';

/* Section icons. Inline SVG rather than emoji so they inherit `currentColor`
   and match the tracker exactly. */
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

/** CSS modifier for a priority label, with a safe fallback for junk data. */
const priorityTone = (priority) => {
  const key = String(priority || '').toLowerCase();
  return key === 'high' || key === 'medium' || key === 'low' ? key : 'low';
};

/** Wellness score → the words next to it. Bands, not a formula, so the copy can
    never drift out of step with the number it describes. */
function scoreBand(score) {
  if (!score) return { label: 'No score yet', tone: 'idle' };
  if (score >= 80) return { label: 'Excellent', tone: 'high' };
  if (score >= 60) return { label: 'Strong', tone: 'good' };
  if (score >= 40) return { label: 'Building', tone: 'mid' };
  return { label: 'Getting started', tone: 'low' };
}

/* The sentence under the score. Formatting lives in utils/scoreSync.js so the
   copy that names a penalty is testable without rendering anything — and so this
   page only ever displays what the API decided, never derives a penalty itself.
   See that file for the three-outcome rule it words. */
import { scoreSyncLine, scoreSyncTone } from '../utils/scoreSync.js';

const energyTone = (level) => {
  const key = String(level || '').toLowerCase();
  if (key === 'high') return 'high';
  if (key === 'low') return 'low';
  return 'mid';
};

/* Frozen because it is used both as the initial state and as a reset value:
   handing the same array-backed object to `useState` twice is fine as long as
   nothing can write to it, and nothing here does. */
const EMPTY_STATS = Object.freeze({
  daysStreak: 0,
  adherenceRate: 0,
  energyLevel: 'Medium',
  todaysProgress: Object.freeze({ taken: 0, total: 0 }),
  wellnessToday: Object.freeze({
    total: 0, taken: 0, missed: 0, awaiting: 0, decided: 0, adherence: 100, penaltyPoints: 0,
  }),
});

function DashboardPage() {
  const navigate = useNavigate();
  // Mutable so the profile-heal path below can fill it in when the tab holds
  // a token but no cached profile (session handover/migration edge) — without
  // this the page used to fall through to a blank render.
  const [userData, setUserData] = useState(() => {
    try {
      return getStoredUser();
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [todaysSupplements, setTodaysSupplements] = useState([]);
  const [wellnessScore, setWellnessScore] = useState(0);
  const [quickStats, setQuickStats] = useState(EMPTY_STATS);
  const [showCompletionToast, setShowCompletionToast] = useState(false);
  const [priorityLifted, setPriorityLifted] = useState(false);
  const [markTakenToastMessage, setMarkTakenToastMessage] = useState('');
  const [markTakenToastKey, setMarkTakenToastKey] = useState(0);
  // Which time slot has a bulk request in flight, so its button can show
  // progress and refuse a second press instead of double-submitting.
  const [slotPending, setSlotPending] = useState(null);
  const [showNewAssessmentConfirm, setShowNewAssessmentConfirm] = useState(false);
  const [showPriorityBlock, setShowPriorityBlock] = useState(false);
  const [priorityBlock, setPriorityBlock] = useState({ blocked: false, count: 0 });
  const [priorityAssessments, setPriorityAssessments] = useState([]);
  const [scoreHelpOpen, setScoreHelpOpen] = useState(false);
  // Priority Review is a premium entitlement. The API only reports it while the
  // plan includes it, and this guard makes the UI follow a downgrade in the
  // same tick — otherwise the banner, the "Paused" card and the lockout modal
  // kept showing premium behaviour until the next dashboard fetch landed.
  const { canAccess } = useSubscription();
  const priorityEntitled = canAccess('priorityAssessment');
  const priorityItems = priorityEntitled ? priorityAssessments : [];
  const priorityPaused = priorityEntitled && priorityBlock.blocked;

  /* The plan day the server is on. The heading below is built from this rather
     than from `new Date()`, because at 2 AM the calendar date is the PREVIOUS day
     and it used to print "Sunday 4 October" above doses belonging to the plan day
     that opened on the 3rd. */
  const [planDayKey, setPlanDayKey] = useState('');

  const scoreHelpRef = useRef(null);
  const scoreHelpBtnRef = useRef(null);

  /* Has real content ever arrived? A ref, not state, on purpose:
     `fetchDashboardData` is a `useCallback` with an empty dependency list and
     must not grow one (every render would hand callers a new function, and the
     refresh subscription below would re-attach on every data change), so it
     cannot read this from state. It only ever needs the CURRENT value, and a
     ref is exactly that. */
  const hasContentRef = useRef(false);

  const fetchDashboardData = useCallback(async (options) => {
    /* A refresh the user asked for WHILE already looking at the dashboard must
       not blank the page. `loading` gates a full-screen spinner that replaces
       every card, so flipping it here swapped the whole dashboard out and back
       — a spinner flash for data that lands in a couple of hundred ms, which
       reads as a glitch rather than a refresh. `silent` keeps the current
       content on screen and swaps the values underneath it.

       It degrades to an ordinary load when there is nothing worth keeping: on
       a first mount, or while the error / missing-profile screens are up. In
       those states a spinner — or the retry that clears the error — is exactly
       what the user needs, and `hasContentRef` is still false, so it happens. */
    const silent = options?.silent === true && hasContentRef.current;

    try {
      if (!silent) {
        setLoading(true);
        setError('');
      }
      const data = await getDashboard();
      // Set before the branches below so the empty-state account (a brand new
      // user with no assessment) counts as content: it is a real, settled page
      // and a refresh over it should be silent too.
      hasContentRef.current = true;

      // Token without a cached profile: pull the profile once from the API
      // instead of letting the !userData check below blank the page.
      if (!getStoredUser()) {
        try {
          const me = await getMyProfile();
          const profile = me?.user || me;
          if (profile && (profile._id || profile.email)) {
            setStoredUser(profile);
            setUserData(profile);
          }
        } catch { /* falls through to the !userData fallback */ }
      }

      if (!data.hasAssessment) {
        // Set empty/default state for new users without assessment
        setTodaysSupplements([]);
        setWellnessScore(0);
        setQuickStats(EMPTY_STATS);
        setPriorityBlock(data.priorityBlock || { blocked: false, count: 0 });
        setPriorityAssessments(data.priorityAssessments || []);
        return;
      }

      // Adopt the server's plan day BEFORE anything reads it, so the heading and
      // the doses it labels are always the same day.
      setPlanDayKey(data.planDay?.todayKey || '');
      setTodaysSupplements(sortPlan(data.todaysSupplements || []));
      setWellnessScore(data.stats.wellnessScore || 0);
      setQuickStats({
        daysStreak: data.stats.daysStreak || 0,
        adherenceRate: data.stats.adherenceRate || 0,
        energyLevel: data.stats.energyLevel || 'Medium',
        todaysProgress: data.stats.todaysProgress || { taken: 0, total: 0 },
        // The window-aware split the score was computed from. An older server
        // omits it, and scoreSyncLine() renders nothing rather than guessing.
        wellnessToday: data.stats.wellnessToday || EMPTY_STATS.wellnessToday,
      });
      setPriorityBlock(data.priorityBlock || { blocked: false, count: 0 });
      setPriorityAssessments(data.priorityAssessments || []);
    } catch (err) {
      // A rejected session (401 + SESSION_* code) is already handled
      // globally by api.js: this tab's copy is cleared and it redirects to
      // /login with an explanatory notice. Logging it here used to spam the
      // console every time the visibility handler re-fired on a doomed
      // session — so teardowns stay silent and un-surfaced.
      const isSessionTeardown = err?.status === 401 && err?.code;
      if (!isSessionTeardown) {
        console.error('Error fetching dashboard:', err);
        // A failed SILENT refresh keeps what is on screen. Replacing a whole
        // dashboard with an error page because a background refetch timed out
        // would throw away the user's data over a transient network blip — and
        // the click they made still did what they asked (scrolled to the top).
        // The next ordinary load surfaces the failure like any other.
        if (!silent) {
          setError((err && err.message) || 'Failed to load dashboard data.');
        }
      }
    } finally {
      // The spinner must ALWAYS clear — even if a handler above threw —
      // otherwise the page sits on the loader forever. A silent refresh never
      // raised it, so it must not lower it either (that would blank the page).
      if (!silent) setLoading(false);
    }
  }, []);

  // Initial dashboard load + auth guard + realtime refresh
  useEffect(() => {
    // Get user data from the tab session
    const token = getToken();

    if (!token) {
      navigate('/login');
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial dashboard load
    fetchDashboardData();

    // Realtime: refresh the moment the user returns to the tab
    const handleVisible = () => {
      if (document.visibilityState === 'visible' && getToken()) {
        fetchDashboardData();
      }
    };
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [navigate, fetchDashboardData]);

  // The brand control in the Navbar, pressed while already on this page, has
  // nowhere to navigate to — so it scrolls to the top and asks for a refresh
  // from here instead. Silent, so the dashboard is not swapped for a spinner
  // (see fetchDashboardData). Mounted only while this page is on screen, so the
  // request costs nothing anywhere else.
  useEffect(
    () => subscribeDashboardRefresh(() => fetchDashboardData({ silent: true })),
    [fetchDashboardData],
  );

  /* Watch the plan day. When it rolls over, everything on screen is yesterday's —
     so refetch rather than leaving a finished plan up until the user reloads by
     hand. Armed only once there is a plan to roll over INTO.
     `usePlanDay` returns the day to render: the server's once it has answered,
     and the local rule until then. */
  const onPlanDayReset = useCallback(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);
  const todayKey = usePlanDay(planDayKey, onPlanDayReset, { enabled: todaysSupplements.length > 0 });

  // The score explainer opens and closes like any other popover: a click
  // anywhere outside closes it, Escape closes it and hands focus back to the
  // button that opened it. It used to be a `:hover` panel, so it could not be
  // reached at all by keyboard or on a touch screen.
  useEffect(() => {
    if (!scoreHelpOpen) return undefined;
    const onPointerDown = (event) => {
      if (!scoreHelpRef.current?.contains(event.target)) setScoreHelpOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      setScoreHelpOpen(false);
      scoreHelpBtnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [scoreHelpOpen]);

  // Morning / Afternoon / Evening sections, in the fixed order the tracker uses.
  // Declared before the plan callbacks below, which read it to find a slot.
  const slotGroups = useMemo(() => groupBySlot(todaysSupplements), [todaysSupplements]);

  /* The clock the time windows are judged against. Re-renders on a timer and on
     wake, so a window that closes while the page is open does not stay tickable
     until a reload. See utils/slotSchedule.js for the windows themselves.

     This used to be a private `useState` + interval pair written out inline, and
     the greeting added a second reading of the clock to render alongside these
     windows. Two readings is how "Good afternoon" ends up sitting above a locked
     Night stack — they disagree for the length of a tick, and only on a boundary,
     which is the worst time to be wrong. There is now one clock, and the greeting
     below is handed it. */
  const now = useNow();

  /* The page, laid out for the current moment: the one open frame, Anytime, and
     the tray of doses whose window has closed. The SAME function the tracker
     uses, so the two pages cannot disagree about what is on screen. */
  const plan = useMemo(() => layoutPlan(slotGroups, now), [slotGroups, now]);

  // The dead hours close New Assessment here as well as on the form itself.
  const deadHours = isDeadHour(now);

  /* Shared post-update bookkeeping for the single tick and the slot press, so
     the two can never diverge on streak, adherence or the priority lifecycle. */
  const applyIntakeResult = useCallback(async (result, { toastMessage } = {}) => {
    if (!result?.stats) return;
    setQuickStats(prev => ({
      ...prev,
      adherenceRate: result.stats.overallAdherence,
      daysStreak: result.stats.daysStreak,
      todaysProgress: result.stats.todaysProgress,
      wellnessToday: result.stats.wellnessToday || prev.wellnessToday,
    }));
    setWellnessScore(result.stats.wellnessScore);

    const { taken, total } = result.stats.todaysProgress;
    if (taken === total && total > 0) {
      // Hide the "marked as taken" toast immediately
      setMarkTakenToastMessage('');
      // Flag auto-lifted when the last supplement completed the plan
      setPriorityLifted(!!result.priorityLifted);
      if (result.priorityLifted) {
        // Refresh the gate + banner state right away
        fetchDashboardData();
      }
      // Strict gate: undo after an auto-lift reinstates the restriction
      if (result.priorityReflagged) {
        setMarkTakenToastKey(prev => prev + 1);
        setMarkTakenToastMessage('Priority review reinstated — new assessments paused again.');
        fetchDashboardData();
      }
      // Show completion toast
      setShowCompletionToast(true);
      // Auto-hide after 4 seconds
      setTimeout(() => setShowCompletionToast(false), 4000);
    } else if (toastMessage) {
      // Show toast when marking as taken (but not completed all)
      // Increment key to force re-render even if previous toast is still showing
      setMarkTakenToastKey(prev => prev + 1);
      setMarkTakenToastMessage(toastMessage);
    }
  }, [fetchDashboardData]);

  const handleSupplementToggle = useCallback(async (id) => {
    const supplement = todaysSupplements.find(s => s.id === id);
    if (!supplement) return;

    const newTakenState = !supplement.taken;

    // Optimistic update UI
    setTodaysSupplements((prev) => sortPlan(prev.map((sup) => (
      sup.id === id
        ? { ...sup, taken: newTakenState, takenAt: newTakenState ? new Date() : null }
        : sup
    ))));

    try {
      const result = await updateIntake(id, newTakenState);
      await applyIntakeResult(
        result,
        newTakenState ? { toastMessage: 'Supplement marked as taken' } : {}
      );
    } catch (err) {
      console.error('Error updating intake:', err);
      // Revert optimistic update on error
      setTodaysSupplements((prev) =>
        prev.map((sup) =>
          sup.id === id ? { ...sup, taken: !newTakenState, takenAt: supplement.takenAt } : sup
        )
      );
    }
  }, [todaysSupplements, applyIntakeResult]);

  /* One press for a whole time slot. The server writes the batch as a single
     update and computes the streak from the FINAL state, so pressing "take all
     morning" five times cannot award and then revoke the day-complete streak
     five times on the way through. */
  const handleSlotTaken = useCallback(async (slotKey) => {
    const group = slotGroups.find(g => g.key === slotKey);
    if (!group) return;
    const ids = pendingIds(group.items);
    if (ids.length === 0) return;

    // Snapshot the rows being changed so a failure restores exactly what was
    // there, rather than assuming they were all untaken.
    const previous = todaysSupplements.filter(sup => ids.includes(sup.id));
    const takenAt = new Date();

    setSlotPending(slotKey);
    setTodaysSupplements((prev) => sortPlan(prev.map((sup) => (
      ids.includes(sup.id) ? { ...sup, taken: true, takenAt } : sup
    ))));

    try {
      const result = await updateIntakeBulk(ids, true);
      await applyIntakeResult(result, {
        toastMessage: `${ids.length} ${group.label.toLowerCase()} supplements marked as taken`,
      });
    } catch (err) {
      console.error('Error marking time slot as taken:', err);
      setTodaysSupplements((prev) => {
        const restored = new Map(previous.map(sup => [sup.id, sup]));
        return prev.map(sup => restored.get(sup.id) ?? sup);
      });
      setMarkTakenToastKey(prev => prev + 1);
      setMarkTakenToastMessage('Could not update those supplements. Please try again.');
    } finally {
      setSlotPending(null);
    }
  }, [slotGroups, todaysSupplements, applyIntakeResult]);

  const navigateToCard = (cardName) => {
    switch (cardName) {
      case 'assessment': {
        // Dead hours close this action too. The card and the empty-state button
        // are already disabled, so this is the backstop against a programmatic
        // activation — and it re-reads the clock rather than trusting the render.
        if (isDeadHour(new Date())) break;
        // Priority gate: an unresolved Priority assessment must finish first
        if (priorityPaused) {
          setShowPriorityBlock(true);
          break;
        }
        // Check if user has supplements that haven't been taken today
        const hasUnfinishedSupplements = todaysSupplements.some(s => !s.taken);
        if (hasUnfinishedSupplements && todaysSupplements.length > 0) {
          setShowNewAssessmentConfirm(true);
        } else {
          // Just navigate to assessment - don't force clear if there's in-progress work
          navigate('/assessment');
        }
        break;
      }
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

  // ── Derived view state ───────────────────────────────────────────────────
  const takenCount = useMemo(
    () => todaysSupplements.filter(s => s.taken).length,
    [todaysSupplements],
  );
  const planPercent = todaysSupplements.length
    ? Math.round((takenCount / todaysSupplements.length) * 100)
    : 0;
  /* One supplement row. Extracted so the active frame and the missed tray show
     the SAME row — they used to be separate inline blocks, which is how a
     "Taken" pill ends up on one and a button on the other for identical data. */
  const renderRow = (supplement, { missed = false, locked = false, slotKey = '' } = {}) => {
    const isTaken = !!supplement.taken;
    // Judged against the row's OWN window, from its timestamp — not against the
    // clock now. A dose recorded at 1:03 AM for a 10 PM slot reads "Took it
    // Late" even when it is looked at again at lunchtime.
    const late = isTaken && isTakenLate(supplement, slotKey || supplement.missedSlot);
    return (
      <div
        key={supplement.id}
        className={[
          'supplement-item',
          `supplement-item--${priorityTone(supplement.priority)}`,
          isTaken ? 'is-taken' : '',
          !isTaken && missed ? 'supplement-item--missed' : '',
          !isTaken && locked ? 'supplement-item--locked' : '',
        ].filter(Boolean).join(' ')}
      >
        <div className="supplement-info">
          <div className="supplement-header">
            <h4 className="supplement-name">{supplement.name}</h4>
            {supplement.priority && (
              <span className={`priority-chip priority-chip--${priorityTone(supplement.priority)}`}>
                {supplement.priority}
              </span>
            )}
            {isTaken ? (
              <span className="taken-badge">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                taken
              </span>
            ) : missed ? (
              <span className="missed-badge">Missed</span>
            ) : null}
          </div>
          <p className="supplement-details">
            {supplement.dosage} - {supplement.scheduledTime}
          </p>
          <p className="supplement-time">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {isTaken
              ? `Taken at ${new Date(supplement.takenAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${late ? ' · late' : ''}`
              : `Best Time: ${supplement.scheduledTime}`}
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
          <span className="supplement-locked-pill">Locked</span>
        ) : (
          <button
            type="button"
            className="supplement-btn"
            onClick={() => handleSupplementToggle(supplement.id)}
            disabled={slotPending !== null}
            aria-label={`Mark ${supplement.name} as taken`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {missed ? 'Took it late' : 'Mark as Taken'}
          </button>
        )}
      </div>
    );
  };

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
        aria-labelledby={`dash-slot-${group.key}`}
      >
        <header className="slot-group__header">
          <span className="slot-group__label">
            <span className={`slot-group__icon slot-group__icon--${group.key}`} aria-hidden="true">
              {SLOT_ICONS[group.key]}
            </span>
            <span className="slot-group__names">
              <h4 id={`dash-slot-${group.key}`} className="slot-group__title">{group.label}</h4>
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
                onClick={() => handleSlotTaken(group.key)}
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

  const band = scoreBand(wellnessScore);
  // What today is doing to the number, in the user's own terms.
  const syncLine = useMemo(() => scoreSyncLine(quickStats.wellnessToday), [quickStats.wellnessToday]);
  // The plan day, once the server has named one; the local rule covers the gap
  // before the first response so the heading is never blank while loading.
  /* The heading date, built from the PLAN DAY KEY the server sent.
     It used to be `new Date().toLocaleDateString(...)` — the calendar date,
     printed directly above doses belonging to the plan day. Between midnight and
     4 AM those are different days, so it read as a fresh untouched morning above
     yesterday's completed plan.

     The key is split and reassembled on a UTC cursor rather than handed to
     `new Date(key)`: a bare YYYY-MM-DD is parsed as UTC midnight and then
     formatted in the HOST's zone, which is the wrong weekday west of Greenwich. */
  const todayLabel = useMemo(() => {
    const [y, m, d] = todayKey.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    return date.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
  }, [todayKey]);
  const hasPlan = todaysSupplements.length > 0;

  /* The heading is "<Time> <User>" — the part of day, and who is signed in here.
     Two facts that arrive independently, so the punctuation between them is
     decided once, in utils/greeting.js, rather than spliced onto the front of a
     string in the markup. `now` is the same reading the dose windows above are
     judged against, so the greeting cannot name one part of the day while the
     page shows another. */
  const greeting = useMemo(() => greetingFor(userData, now), [userData, now]);

  if (loading) {
    return (
      <div className="dashboard-wrapper">
        <Navbar />
        <div className="dashboard-loading-simple">
          <div className="loading-spinner-simple"></div>
        </div>
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
            <button type="button" onClick={() => navigate('/assessment')} className="dashboard-error__btn">
              Go to assessment
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!userData) {
    // Never render a blank white page: the session exists but the profile
    // could not be loaded — show a retryable message instead.
    return (
      <div className="dashboard-wrapper">
        <Navbar />
        <div className="dashboard-container">
          <div className="dashboard-error">
            <p>We couldn&apos;t load your profile. Please try again.</p>
            <button type="button" onClick={() => fetchDashboardData()} className="dashboard-error__btn">
              Try again
            </button>
          </div>
        </div>
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

      {/* Priority Block Modal — new assessments locked until review finishes */}
      {showPriorityBlock && priorityPaused && (
        <ConfirmModal
          title="Priority Review In Progress"
          message={`You have ${priorityBlock.count} prioritized assessment${priorityBlock.count === 1 ? '' : 's'} that must finish review first. New assessments are paused until an administrator resolves it. Please follow your current plan and check your notifications.`}
          confirmText="View in History"
          cancelText="Close"
          type="warning"
          onConfirm={() => {
            setShowPriorityBlock(false);
            navigate('/history');
          }}
          onCancel={() => setShowPriorityBlock(false)}
        />
      )}

      {/* Completion Toast */}
      {showCompletionToast && (
        <div className="completion-toast" role="status">
          <div className="completion-toast-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div className="completion-toast-content">
            <h3 className="completion-toast-title">
              {priorityLifted
                ? 'Priority review completed! New assessments are unlocked.'
                : "Great job! You completed today's supplement plan."}
            </h3>
            <p className="completion-toast-subtitle">
              {priorityLifted
                ? 'All supplements taken — the flag on your assessment has been lifted.'
                : 'Your adherence and streak have been updated.'}
            </p>
          </div>
          <button
            type="button"
            className="completion-toast-close"
            aria-label="Dismiss"
            onClick={() => setShowCompletionToast(false)}
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

      <div className="dashboard-container">
        {/* Welcome Section */}
        <header className="dashboard-welcome">
          <p className="dashboard-eyebrow">
            <span className="dashboard-eyebrow__dot" aria-hidden="true" />
            {todayLabel}
          </p>
          <h1 className="dashboard-title">{greeting}</h1>
          <p className="dashboard-subtitle">
            {hasPlan || wellnessScore > 0
              ? "Here's your personalized wellness dashboard"
              : "Get started by taking a quick health assessment to receive personalized supplement recommendations"}
          </p>
        </header>

        {/* Priority Review Banner — surfaced whenever an assessment is flagged.
            `.sw-banner` is the shared component in theme.css; the results page
            renders the same markup. */}
        {priorityItems.length > 0 && (
          <div className="sw-banner" role="alert">
            <div className="sw-banner__icon" aria-hidden="true">⚑</div>
            <div className="sw-banner__body">
              <strong>
                Priority review{priorityItems.length === 1 ? '' : 's'} in progress ({priorityItems.length})
              </strong>
              {priorityItems.slice(0, 2).map(item => (
                <span key={item.id} className="sw-banner__item">
                  Flagged {item.flaggedAt ? new Date(item.flaggedAt).toLocaleDateString() : new Date(item.createdAt).toLocaleDateString()}
                  {(item.reasons || []).length > 0 ? ` — ${(item.reasons || []).slice(0, 2).join('; ')}` : ''}
                </span>
              ))}
              <span className="sw-banner__hint">
                Finish this review first — new assessments are paused until it is resolved.
              </span>
            </div>
            <button
              type="button"
              className="sw-banner__btn"
              onClick={() => navigate('/history')}
            >
              View
            </button>
          </div>
        )}

        {/* Action Cards */}
        <div className="dashboard-cards">
          {ACTION_CARDS.map((card) => {
            const blocked = card.key === 'assessment' && priorityPaused;
            // New Assessment is closed during the dead hours, same as the form it
            // leads to. Without this the card still looked live and walked the
            // user straight into a page they could not use — and this card is
            // the main way in, so it has to carry the lock itself.
            const snoozed = card.key === 'assessment' && deadHours;
            const inert = blocked || snoozed;
            const cardLabel = blocked
              ? `${card.label} — paused until the priority review finishes`
              : snoozed
                ? `${card.label} — closed until ${DEAD_HOURS.endsAt}`
                : card.label;
            return (
              <button
                type="button"
                key={card.key}
                className={[
                  'dashboard-card',
                  `dashboard-card--${card.tone}`,
                  blocked ? 'dashboard-card--blocked' : '',
                  snoozed ? 'dashboard-card--snoozed' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => { if (!inert) navigateToCard(card.key); }}
                disabled={inert}
                aria-label={cardLabel}
                title={snoozed ? `Closed between midnight and ${DEAD_HOURS.endsAt}` : undefined}
              >
                <span className="card-icon">{card.icon}</span>
                <span className="card-body">
                  <span className="card-title">{card.label}</span>
                  <span className="card-hint">
                    {snoozed ? `Closed until ${DEAD_HOURS.endsAt}` : card.hint}
                  </span>
                </span>
                <span className="card-arrow" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </span>
                {blocked && <span className="card-blocked-tag">Paused</span>}
                {snoozed && <span className="card-blocked-tag card-blocked-tag--snoozed">Asleep</span>}
              </button>
            );
          })}
        </div>

        {/* Bottom Section */}
        <div className="dashboard-bottom">
          {/* Today's Supplements */}
          <section className="dashboard-section supplements-section" aria-labelledby="supplements-heading">
            <div className="section-header-with-legend">
              <div className="section-title-group">
                <h2 className="section-title" id="supplements-heading">Today&apos;s Supplements</h2>
                {hasPlan && (
                  <span className={`section-count${takenCount === todaysSupplements.length ? ' is-done' : ''}`}>
                    {takenCount}/{todaysSupplements.length} taken
                  </span>
                )}
              </div>
              <div className="priority-legend">
                <span className="legend-label">Priority:</span>
                <span className="legend-item">
                  <svg width="7" height="7" viewBox="0 0 24 24" fill="#10b981" aria-hidden="true">
                    <circle cx="12" cy="12" r="12" />
                  </svg>
                  High
                </span>
                <span className="legend-item">
                  <svg width="7" height="7" viewBox="0 0 24 24" fill="#f59e0b" aria-hidden="true">
                    <circle cx="12" cy="12" r="12" />
                  </svg>
                  Medium
                </span>
                <span className="legend-item">
                  <svg width="7" height="7" viewBox="0 0 24 24" fill="#94a3b8" aria-hidden="true">
                    <circle cx="12" cy="12" r="12" />
                  </svg>
                  Low
                </span>
              </div>
            </div>

            {hasPlan && (
              <div
                className="plan-progress"
                role="progressbar"
                aria-valuenow={planPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Today's supplement progress"
              >
                <div
                  className={`plan-progress__fill${planPercent === 100 ? ' is-complete' : ''}`}
                  style={{ width: `${planPercent}%` }}
                />
              </div>
            )}

            {!hasPlan ? (
              <div className="empty-state">
                <div className="empty-state-icon" aria-hidden="true">
                  <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    {wellnessScore === 0 ? (
                      <>
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </>
                    ) : (
                      <>
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                      </>
                    )}
                  </svg>
                </div>
                <p className="empty-state-title">
                  {wellnessScore === 0
                    ? 'No Supplement Plan Yet'
                    : "You haven't added any supplements to your plan yet."}
                </p>
                <p className="empty-state-subtitle">
                  {wellnessScore === 0
                    ? 'Complete a health assessment and add your recommended supplements to your plan to view today\'s supplements.'
                    : 'Browse AI recommendations and add supplements to start tracking.'}
                </p>
                <button
                  type="button"
                  className="btn-go-recommendations"
                  // Only the "Take Assessment" half of this button is closed
                  // during the dead hours; "Go to AI Recommendations" browses an
                  // existing plan and has no reason to be.
                  onClick={() => {
                    if (wellnessScore === 0) {
                      if (!deadHours) navigate('/assessment');
                    } else {
                      navigate('/recommendations');
                    }
                  }}
                  disabled={wellnessScore === 0 && deadHours}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {wellnessScore === 0 ? (
                      <>
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                        <path d="M9 14l2 2 4-4" />
                      </>
                    ) : (
                      <>
                        <path d="M12 2a10 10 0 0 1 7.94 16.06L12 22l-7.94-3.94A10 10 0 0 1 12 2z" />
                        <circle cx="12" cy="11" r="3" />
                      </>
                    )}
                  </svg>
                  {wellnessScore === 0 ? 'Take Assessment' : 'Go to AI Recommendations'}
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
                        aria-labelledby={`dash-ph-${placeholder.key}`}
                      >
                        <header className="slot-group__header">
                          <span className="slot-group__label">
                            <span className={`slot-group__icon slot-group__icon--${placeholder.key}`} aria-hidden="true">
                              {SLOT_ICONS[placeholder.key]}
                            </span>
                            <span className="slot-group__names">
                              <h4 id={`dash-ph-${placeholder.key}`} className="slot-group__title">{placeholder.label}</h4>
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
                  <section className="slot-tray" aria-labelledby="dash-missed-tray">
                    <header className="slot-tray__header">
                      <h4 id="dash-missed-tray" className="slot-tray__title">{plan.missed.title}</h4>
                      <span className="slot-tray__count">{plan.missed.total}</span>
                      <span className="slot-tray__note">Window passed — you can still record these</span>
                    </header>
                    <div className="supplements-list">
                      {plan.missed.items.map((supplement) => renderRow(supplement, { missed: true }))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </section>

          {/* Right Column */}
          <div className="dashboard-right-column">
            {/* Wellness Score */}
            <section className="dashboard-section score-section" aria-labelledby="score-heading">
              <div className="section-title-with-info">
                <h2 className="section-title" id="score-heading">Wellness Score</h2>
                <div className="info-icon-wrapper" ref={scoreHelpRef}>
                  <button
                    type="button"
                    ref={scoreHelpBtnRef}
                    className="info-icon-btn"
                    title="How is this calculated?"
                    aria-label="How is this calculated?"
                    aria-expanded={scoreHelpOpen}
                    aria-controls="wellness-score-help"
                    onClick={() => setScoreHelpOpen(open => !open)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  </button>

                  {scoreHelpOpen && (
                    <div className="wellness-info-tooltip" id="wellness-score-help" role="dialog" aria-label="How the wellness score is calculated">
                      <h4 className="wellness-info-title">How Wellness Score Works</h4>
                      <div className="wellness-info-breakdown">
                        <div className="wellness-info-item">
                          <strong>🎯 Health Baseline (0-30)</strong>
                          <p>AI analyzes your assessment to determine your starting health state.</p>
                        </div>
                        <div className="wellness-info-item">
                          <strong>📊 Adherence (0-50)</strong>
                          <p>
                            60% today, 40% all time &mdash; worth up to 50 points. Today counts only the
                            doses you have actually had the chance to take.
                          </p>
                        </div>
                        <div className="wellness-info-item">
                          <strong>🔥 Streak Bonus (0-20)</strong>
                          <p>Maintaining a daily streak contributes up to 20 points.</p>
                        </div>
                      </div>

                      {/* The part people ask about, stated exactly as the server
                          applies it: a window still open costs nothing, a window
                          that closed unticked costs everything, and a late entry
                          costs nothing either way. */}
                      <div className="wellness-info-rules">
                        <strong>How missed doses are judged</strong>
                        <ul>
                          <li><span className="is-ok">On time</span> ticked inside its window &mdash; full credit.</li>
                          <li><span className="is-ok">Late</span> ticked after it closed &mdash; still full credit.</li>
                          <li><span className="is-open">Still open</span> unticked, window not finished &mdash; costs nothing yet.</li>
                          <li><span className="is-bad">Missed</span> unticked once its window closed &mdash; costs points, now.</li>
                        </ul>
                      </div>

                      <p className="wellness-info-note">
                        <strong>Max: 100</strong> &mdash; Your score grows as you stay consistent!
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="score-display">
                <div className="score-gauge">
                  <ScoreGauge value={wellnessScore} />
                  <div className="score-gauge__center">
                    <div className="score-number">{wellnessScore}</div>
                    <div className="score-band" data-tone={band.tone}>{band.label}</div>
                  </div>
                </div>
                <p className="score-caption">
                  <strong>{wellnessScore}</strong> out of 100 — {band.tone === 'idle'
                    ? 'finish an assessment to start scoring.'
                    : `you are in the ${band.label.toLowerCase()} band.`}
                </p>
                {/* Today's contribution, said out loud. A score that moves with
                    nothing on screen to explain it reads as a glitch; this names
                    the doses responsible. Hidden when there is nothing true to
                    say, because "everything taken" means nothing on an empty plan. */}
                {syncLine && (
                  <p className="score-sync" data-tone={scoreSyncTone(quickStats.wellnessToday)}>
                    <span className="score-sync__dot" aria-hidden="true" />
                    {syncLine}
                  </p>
                )}
              </div>
            </section>

            {/* Quick Stats */}
            <section className="dashboard-section stats-section" aria-labelledby="stats-heading">
              <h2 className="section-title" id="stats-heading">Quick Stats</h2>
              <div className="stats-grid">
                <div className="stat-item stat-item--streak">
                  <div className="stat-icon-box" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
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

                <div className="stat-item stat-item--adherence">
                  <div className="stat-icon-box" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                  </div>
                  <div className="stat-content">
                    <p className="stat-label">Adherence rate</p>
                    <p className="stat-value">{quickStats.adherenceRate}%</p>
                  </div>
                  <div className="stat-meter" aria-hidden="true">
                    <div className="stat-meter__fill" style={{ width: `${Math.min(Math.max(quickStats.adherenceRate, 0), 100)}%` }} />
                  </div>
                </div>

                <div className="stat-item stat-item--progress">
                  <div className="stat-icon-box" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <div className="stat-content">
                    <p className="stat-label">Today&apos;s Progress</p>
                    <p className="stat-value">{quickStats.todaysProgress.taken}/{quickStats.todaysProgress.total}</p>
                  </div>
                  <div className="stat-meter" aria-hidden="true">
                    <div
                      className="stat-meter__fill"
                      style={{
                        width: `${quickStats.todaysProgress.total
                          ? Math.round((quickStats.todaysProgress.taken / quickStats.todaysProgress.total) * 100)
                          : 0}%`,
                      }}
                    />
                  </div>
                  {quickStats.todaysProgress.taken === quickStats.todaysProgress.total && quickStats.todaysProgress.total > 0 && (
                    <div className="stat-check-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  )}
                </div>

                <div className={`stat-item stat-item--energy is-${energyTone(quickStats.energyLevel)}`}>
                  <div className="stat-icon-box" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" />
                    </svg>
                  </div>
                  <div className="stat-content">
                    <p className="stat-label">Energy level</p>
                    <p className="stat-value">{quickStats.energyLevel || 'Medium'}</p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Wellness score gauge ───────────────────────────────────────────────────
   A ring, not a bar, so the number and its progress read as one object.

   THREE THINGS HAVE TO AGREE, and each one is derived rather than typed:

   • The arc is a dash of length `C × pct` starting at the path origin, so it
     begins at 12 o'clock and sweeps clockwise. The common
     `strokeDashoffset = C × (1 − pct)` shortcut draws the arc's TAIL, which on
     a score of 60 left the ring starting part-way round the dial.

   • The CSS puts `rotate(-90deg)` on the element, which is what lifts the
     circle's path origin (3 o'clock in its own coordinate system) to 12
     o'clock. Gradients are painted in that SAME unrotated system, so the
     gradient's endpoints have to be stated there too — computing them in
     already-rotated coordinates puts the ramp across the middle of the ring
     instead of along it, and the arc comes out green at both ends with a
     stripe of indigo through the middle.

   • Both endpoints follow the current score. Pinning them to a fixed full arc
     leaves the last hue sitting at a point a shorter arc never reaches.

   One honest limitation: `linearGradient` is straight, so the ramp is spread
   along the chord from the arc's start to its end rather than bent around the
   curve. The stops below are placed to suit that geometry, which is why they
   are not at even intervals. */
const GAUGE_RADIUS = 52;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
const GAUGE_START = { x: 60 + GAUGE_RADIUS, y: 60 };

/** The arc's end point, in the circle's own (unrotated) coordinates. */
function gaugeEndPoint(pct) {
  const sweep = (Math.min(Math.max(pct, 0), 100) / 100) * 2 * Math.PI;
  return {
    x: 60 + GAUGE_RADIUS * Math.cos(sweep),
    y: 60 + GAUGE_RADIUS * Math.sin(sweep),
  };
}

function ScoreGauge({ value }) {
  const safe = Math.min(Math.max(Number(value) || 0, 0), 100);
  const end = gaugeEndPoint(safe);
  return (
    <svg className="score-gauge__ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient
          id="score-gauge-gradient"
          gradientUnits="userSpaceOnUse"
          x1={GAUGE_START.x}
          y1={GAUGE_START.y}
          x2={end.x}
          y2={end.y}
        >
          <stop offset="0%" stopColor="#10b981" />
          <stop offset="35%" stopColor="#22d3ee" />
          <stop offset="68%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <circle className="score-gauge__track" cx="60" cy="60" r={GAUGE_RADIUS} />
      {/* Nothing is drawn at zero rather than a zero-length dash: a round line
          cap on a zero-length stroke paints a stray dot on the dial. */}
      {safe > 0 && (
        <circle
          className="score-gauge__value"
          cx="60"
          cy="60"
          r={GAUGE_RADIUS}
          strokeDasharray={`${GAUGE_CIRCUMFERENCE * (safe / 100)} ${GAUGE_CIRCUMFERENCE}`}
        />
      )}
    </svg>
  );
}

export default DashboardPage;
