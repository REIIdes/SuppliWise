/**
 * AI-Powered Recommendations.
 *
 * WHY THIS PAGE IS NOT A THINNER COPY OF THE RESULTS PAGE
 *
 * The two read the same `aiResults.recommendations` array, but they answer
 * different questions. The results page is the moment of generation: the full
 * plan, the schedule, the lifestyle advice, all of it at once. This page is
 * where a member goes afterwards to decide what to actually take — so it leads
 * with the plan toggle, and it filters by what is already in the plan.
 *
 * It previously rendered a fraction of the data the server produces, using its
 * own copies of the priority/sort/filter logic, and every one of those copies
 * drifted. The reading of a recommendation now lives in
 * `utils/recommendationView.js` and the overlays in
 * `Components/SupplementDetail/`, so this page and the results page cannot
 * disagree about the same record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import {
  EvidenceInfoModal,
  SupplementDetailModal,
} from '../Components/SupplementDetail/SupplementDetail';
import { getHistory, getMyPlan, addSupplementToPlan, removeSupplementFromPlan, getToken } from '../api';
import {
  DETAIL_MODE_KEY,
  PRIORITY_TABS,
  cleanTriggeredBy,
  confidenceOf,
  countByPriority,
  displayEvidence,
  displayReason,
  filterByPriority,
  fixChars,
  foodPills,
  hasInteractions,
  isOnPlan,
  nameKey,
  planPriority,
  priorityLabel,
  priorityOf,
  recName,
  severityTone,
  sortRecommendations,
  supplementIcon,
} from '../utils/recommendationView';
import './RecommendationsPage.css';

/* ── Empty state ────────────────────────────────────────────────────────
   One component, three different reasons a member sees nothing. The action is
   part of the contract so a state can never be rendered without a way out of
   it — the previous version had two of these and one offered no action at
   all, which is how a member with a working assessment ended up told to take
   one. */
function RecommendationsEmpty({ title, text, action, onAction }) {
  return (
    <div className="rec-empty">
      <div className="rec-empty__icon" aria-hidden="true">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          <line x1="9" y1="12" x2="15" y2="12" />
          <line x1="9" y1="16" x2="13" y2="16" />
        </svg>
      </div>
      <p className="rec-empty__title">{title}</p>
      <p className="rec-empty__text">{text}</p>
      {action && (
        <button type="button" className="sw-btn" onClick={onAction}>{action}</button>
      )}
    </div>
  );
}

/* ── Confidence ─────────────────────────────────────────────────────────
   The server assigns 70-100 and the number decides how the card is ordered
   within its priority band, so it is shown rather than hidden. The bar width
   is clamped in recommendationView; this only decides the colour band. */
function ConfidenceBar({ score }) {
  const [shown, setShown] = useState(0);

  // A timer, not requestAnimationFrame. rAF does not fire in a background tab,
  // so anyone who opened this page in a new tab and had not focused it yet saw
  // a bar stuck at zero — a "0% match" reading for a recommendation scored at
  // 91, which is worse than showing no bar at all.
  useEffect(() => {
    const timer = setTimeout(() => setShown(score), 60);
    return () => clearTimeout(timer);
  }, [score]);

  const tone = score >= 85 ? 'high' : score >= 75 ? 'medium' : 'low';

  return (
    <div className="rec-confidence" data-tone={tone}>
      <div
        className="rec-confidence__track"
        role="meter"
        aria-valuenow={score}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Recommendation match"
      >
        <div className="rec-confidence__fill" style={{ width: `${shown}%` }} />
      </div>
      <span className="rec-confidence__label">{score}% match</span>
    </div>
  );
}

/* ── Food sources ────────────────────────────────────────────────────────
   Rendered as pills rather than a sentence so four foods scan as four things
   to buy, instead of one clause the reader has to parse. */
function FoodPills({ foods }) {
  const pills = foodPills(foods);
  if (pills.length === 0) return null;
  return (
    <div className="rec-pills">
      {pills.map((pill, i) => <span key={`${pill}-${i}`} className="rec-pill">{pill}</span>)}
    </div>
  );
}

/* ── One recommendation ────────────────────────────────────────────────
   Split by detail mode for the same reason the results page is: a reader who
   chose Simplified asked not to be shown a mechanism of action, and showing it
   here anyway makes the setting look broken. */
function RecommendationCard({
  rec,
  expanded,
  onToggle,
  onOpenDetail,
  detailMode,
  onShowEvidenceInfo,
  onPlanToggle,
  onPlan,
  busy,
  added,
}) {
  const name = recName(rec);
  const priority = priorityOf(rec.priority);
  const confidence = confidenceOf(rec);
  const reason = displayReason(rec, detailMode);
  const evidence = displayEvidence(rec, detailMode);
  const foods = foodPills(rec.foods);
  const interactions = fixChars(rec.interactions);
  const triggeredBy = cleanTriggeredBy(rec.triggeredBy);
  const conditionContext = fixChars(rec.conditionContext);
  const sideEffects = detailMode === 'detailed' ? fixChars(rec.sideEffects) : '';
  const severity = rec.severityLevel;

  // Only offer an expansion if there is something behind it. A "More details"
  // button that reveals an empty box is worse than no button.
  const hasDetails = Boolean(evidence || foods.length || sideEffects);
  const showDetails = hasDetails && (
    <button
      type="button"
      className="rec-expand"
      onClick={onToggle}
      aria-expanded={expanded}
    >
      {expanded ? '▲ Less details' : '▼ More details'}
    </button>
  );

  return (
    <article className={`recommendation-card recommendation-card--${priority}`}>
      <header className="recommendation-header">
        <div className="recommendation-title-row">
          <span className="recommendation-icon" aria-hidden="true">{supplementIcon(name)}</span>
          <h3 className="recommendation-name">
            <button type="button" className="recommendation-name-btn" onClick={onOpenDetail}>
              {name || 'Supplement'}
              <span className="recommendation-name-hint">Details ›</span>
            </button>
          </h3>
          <span className={`priority-badge priority-badge--${priority}`}>
            {priorityLabel(priority)} priority
          </span>
          {severity && (
            <span className={`severity-badge severity-badge--${severityTone(severity)}`}>
              {fixChars(severity)}
            </span>
          )}
        </div>
        {confidence !== null && (
          <div className="recommendation-confidence">
            <ConfidenceBar score={confidence} />
          </div>
        )}
      </header>

      {triggeredBy && (
        <p className="recommendation-triggered">
          <span className="recommendation-triggered-label">Recommended for:</span>{' '}
          {triggeredBy}
        </p>
      )}

      {reason && (
        <div className="recommendation-reason">
          <div className="reason-header">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a10 10 0 0 1 7.94 16.06L12 22l-7.94-3.94A10 10 0 0 1 12 2z" />
              <circle cx="12" cy="11" r="3" />
            </svg>
            <span>Why this supplement?</span>
          </div>
          <p className="reason-text">{reason}</p>
        </div>
      )}

      {conditionContext && (
        <p className="recommendation-context">
          <span aria-hidden="true">🩺</span> {conditionContext}
        </p>
      )}

      <dl className="recommendation-dosage">
        <div className="dosage-item">
          <dt>💊 Dosage</dt>
          <dd>{fixChars(rec.dosage) || 'See the guide'}</dd>
        </div>
        <div className="dosage-item">
          <dt>⏰ Best time</dt>
          <dd>{fixChars(rec.timing) || 'Anytime'}</dd>
        </div>
        {rec.duration && (
          <div className="dosage-item">
            <dt>📅 Duration</dt>
            <dd>{fixChars(rec.duration)}</dd>
          </div>
        )}
      </dl>

      {/* Flagged, never hidden. "None identified" is a claim about a
          medication list the AI may not have complete, so a reader who is on
          something needs to see that it was checked, not that it's fine. */}
      {hasInteractions(interactions) && (
        <p className="recommendation-interaction">
          <span className="recommendation-interaction-label">⚠ Interactions</span>
          {interactions}
        </p>
      )}

      {showDetails && (
        <>
          {expanded && (
            <div className="recommendation-details">
              {evidence && (
                <div className="detail-block detail-block--evidence">
                  <span className="detail-block__label">
                    {detailMode === 'simplified' ? '✓ Backed by research' : '📚 Evidence & References'}
                    <button
                      type="button"
                      className="evidence-info-btn"
                      onClick={onShowEvidenceInfo}
                      aria-label="How we choose evidence"
                      title="How we choose evidence"
                    >
                      ⓘ
                    </button>
                  </span>
                  <p>{evidence}</p>
                </div>
              )}
              {foods.length > 0 && (
                <div className="detail-block detail-block--foods">
                  <span className="detail-block__label">🥗 Also found in</span>
                  <FoodPills foods={rec.foods} />
                </div>
              )}
              {sideEffects && (
                <div className="detail-block detail-block--side-effects">
                  <span className="detail-block__label">⚠ Side effects &amp; safe limits</span>
                  <p>{sideEffects}</p>
                </div>
              )}
            </div>
          )}
          {showDetails}
        </>
      )}

      <div className="recommendation-actions">
        <button
          type="button"
          className={added ? 'btn-added' : 'btn-add-plan'}
          onClick={() => onPlanToggle(rec)}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {added ? (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {busy ? 'Removing…' : 'In your plan'}
            </>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {busy ? 'Adding…' : 'Add to my plan'}
            </>
          )}
        </button>
        {onPlan && (
          <button type="button" className="btn-ghost" onClick={onPlan}>
            Track today
          </button>
        )}
      </div>
    </article>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

function RecommendationsPage() {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [records, setRecords] = useState([]);
  const [consult, setConsult] = useState(null);
  const [profile, setProfile] = useState(null);
  const [hasAssessment, setHasAssessment] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [query, setQuery] = useState('');

  // The plan is held as normalized keys, not raw names. See nameKey() for why
  // the raw name cannot answer "is this already added?".
  const [planKeys, setPlanKeys] = useState(() => new Set());
  const [busyKey, setBusyKey] = useState('');

  const [detailMode, setDetailMode] = useState(() => {
    try {
      return localStorage.getItem(DETAIL_MODE_KEY) === 'detailed' ? 'detailed' : 'simplified';
    } catch {
      return 'simplified';
    }
  });

  const [toast, setToast] = useState(null);
  const [toastKey, setToastKey] = useState(0);
  const [expanded, setExpanded] = useState(() => new Set());
  const [detailTarget, setDetailTarget] = useState(null);
  const [showEvidenceInfo, setShowEvidenceInfo] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const toastTimerRef = useRef(null);
  const detailCache = useRef({});
  const loadTokenRef = useRef(0);

  const INITIAL_VISIBLE = 6;

  /* ── Data ────────────────────────────────────────────────────────────
     A failed load and an empty result are DIFFERENT states and must not look
     alike. This previously caught every error and set an empty list, so a 500
     or a dropped connection told a member with a completed assessment to go
     and complete one — advice that is both wrong and impossible to act on. */
  const load = useCallback(async (token) => {
    try {
      const historyData = await getHistory(1, 5, 'recommendations');
      if (token !== loadTokenRef.current) return;

      const assessments = Array.isArray(historyData.assessments) ? historyData.assessments : [];
      setHasAssessment(assessments.length > 0);

      // The newest assessment that actually carries recommendations. The most
      // recent one may have been saved before the AI finished — or before a
      // provider failed — and showing nothing while an older assessment holds
      // a full plan is the same lie in a different costume.
      const withRecs = assessments.find(
        (item) => Array.isArray(item?.aiResults?.recommendations) && item.aiResults.recommendations.length > 0,
      );
      setRecords(Array.isArray(withRecs?.aiResults?.recommendations) ? withRecs.aiResults.recommendations : []);

      // The patient profile, kept for the supplement-detail panel. The server
      // personalizes that guide from these exact fields, so a request built
      // without them returns generic text while still being labelled as
      // written for this patient.
      setProfile(withRecs || null);

      // The consult-doctor trigger is computed server-side and lives beside the
      // recommendations, not inside them. It is the one instruction on this
      // page that must not be skimmable, so it is lifted out of the array and
      // rendered as a banner.
      setConsult(
        withRecs?.aiResults?.consultDoctor && withRecs.aiResults.consultReason
          ? { reason: withRecs.aiResults.consultReason }
          : null,
      );
      setLoadError('');
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setRecords([]);
      setLoadError(
        err?.status === 403
          ? 'Your plan history is not available on this plan. Upgrade to see your full recommendation history.'
          : err?.message || 'We could not load your recommendations. Please try again.',
      );
    }
  }, []);

  const loadPlan = useCallback(async () => {
    try {
      const planData = await getMyPlan();
      const supplements = Array.isArray(planData?.supplements) ? planData.supplements : [];
      const next = new Set();
      for (const item of supplements) {
        const key = nameKey(item?.name);
        if (key) next.add(key);
      }
      setPlanKeys(next);
    } catch (err) {
      // The plan is decoration here — the recommendations are the page. If it
      // cannot be read, the toggle must not claim everything is absent, so the
      // set is left untouched and the reader is told once.
      setToast({
        type: 'warning',
        message: err?.message || 'Your saved plan could not be loaded, so plan status may be out of date.',
      });
      setToastKey((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      navigate('/login', { replace: true });
      return undefined;
    }

    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;

    // No synchronous setState here. On mount `loading` is already true and the
    // rest already empty, so a reset would be a no-op that costs a render; the
    // reset that IS needed — after a failed load the reader presses "Try
    // again" — belongs to that handler, not to this effect.
    //
    // The plan is not on the critical path: recommendations render without it.
    Promise.all([load(token), loadPlan()]).finally(() => {
      if (token === loadTokenRef.current) setLoading(false);
    });

    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [load, loadPlan, navigate]);

  /** Re-read everything. Used by the retry button, which clears the error. */
  const reload = useCallback(() => {
    setLoading(true);
    setRecords([]);
    setConsult(null);
    setLoadError('');
    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    Promise.all([load(token), loadPlan()]).finally(() => {
      if (token === loadTokenRef.current) setLoading(false);
    });
  }, [load, loadPlan]);

  useEffect(() => {
    try {
      localStorage.setItem(DETAIL_MODE_KEY, detailMode);
    } catch {
      // Storage unavailable — the preference just does not persist.
    }
  }, [detailMode]);

  const showToast = useCallback((type, message) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type, message });
    setToastKey((n) => n + 1);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  }, []);

  /* ── Derived view ──────────────────────────────────────────────────── */

  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = filterByPriority(records, activeTab);
    if (!needle) return base;
    return base.filter((rec) => {
      const name = recName(rec).toLowerCase();
      const reason = fixChars(rec.reason).toLowerCase();
      return name.includes(needle) || reason.includes(needle);
    });
  }, [records, activeTab, query]);

  const sorted = useMemo(() => sortRecommendations(searched, planKeys), [searched, planKeys]);
  const counts = useMemo(() => countByPriority(records), [records]);
  const visible = showAll ? sorted : sorted.slice(0, INITIAL_VISIBLE);
  const addedCount = useMemo(
    () => sorted.reduce((total, rec) => total + (isOnPlan(rec, planKeys) ? 1 : 0), 0),
    [sorted, planKeys],
  );

  /* ── Actions ──────────────────────────────────────────────────────────
     The plan write is where the priority casing matters. The endpoint
     whitelists ['High','Medium','Low'] and stores anything else as 'Medium',
     so a model that answered "high" silently demoted a high-priority
     supplement in the one place the member's day is actually built. */
  const handlePlanToggle = useCallback(async (rec) => {
    const name = recName(rec);
    const key = nameKey(name);
    if (!key) {
      showToast('warning', 'This recommendation has no name, so it cannot be added to your plan.');
      return;
    }

    const wasAdded = planKeys.has(key);
    setBusyKey(key);
    try {
      if (wasAdded) {
        await removeSupplementFromPlan(name);
        setPlanKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        showToast('success', `${name} removed from your plan`);
      } else {
        await addSupplementToPlan({
          name,
          dosage: fixChars(rec.dosage).slice(0, 100),
          timing: fixChars(rec.timing).slice(0, 50) || 'Anytime',
          priority: planPriority(rec.priority),
        });
        setPlanKeys((prev) => new Set(prev).add(key));
        showToast('success', `${name} added to your plan`);
      }
    } catch (err) {
      // Re-read the plan on failure. The common case is a 400 saying it is
      // already there, which means our cached view was stale and the member is
      // about to be told their tap did nothing when it had already worked.
      await loadPlan();
      showToast('warning', err?.message || 'We could not update your plan. Please try again.');
    } finally {
      setBusyKey('');
    }
  }, [planKeys, showToast, loadPlan]);

  const toggleExpanded = useCallback((key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openDetail = useCallback((rec) => {
    const list = (value, drop) => (
      Array.isArray(value) ? value.filter((item) => item && item !== drop) : []
    );
    setDetailTarget({
      name: recName(rec),
      context: {
        age: profile?.age,
        gender: profile?.gender,
        symptoms: list(profile?.symptoms, 'No current symptoms'),
        goals: list(profile?.healthGoals),
        conditions: list(profile?.medicalConditions, 'None'),
        allergies: profile?.allergies || null,
        lifestyle: list(profile?.lifestyleHabits, 'None'),
        diet: profile?.dietType || null,
        pregnancyStatus: profile?.pregnancyStatus || null,
        recommendationReason: fixChars(rec.reason),
      },
    });
  }, [profile]);

  /* ── Render ─────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="recommendations-wrapper">
        <Navbar />
        <div className="recommendations-loading-simple">
          <div className="loading-spinner-simple" role="status" aria-label="Loading your recommendations" />
        </div>
      </div>
    );
  }

  const showError = Boolean(loadError);
  const showNoAssessment = !showError && !hasAssessment;
  const showNoRecs = !showError && hasAssessment && records.length === 0;
  const showNoFilterMatches = !showError && !showNoRecs && sorted.length === 0;

  return (
    <div className="recommendations-wrapper">
      <Navbar />

      {toast && (
        <Toast
          key={toastKey}
          message={toast.message}
          type={toast.type}
          duration={4000}
          onClose={() => setToast(null)}
        />
      )}

      <div className="recommendations-container">
        <header className="recommendations-header">
          <div className="recommendations-header-top">
            <div>
              <h1 className="recommendations-title">AI-Powered Recommendations</h1>
              <p className="recommendations-subtitle">
                Personalized supplement suggestions based on your health assessment
              </p>
            </div>
            {/* One preference, one storage key, honoured on every page. */}
            <div className="detail-mode-toggle" role="group" aria-label="Recommendation detail level">
              <button
                type="button"
                className={`detail-mode-btn ${detailMode === 'simplified' ? 'active' : ''}`}
                onClick={() => setDetailMode('simplified')}
                aria-pressed={detailMode === 'simplified'}
                title="Friendly, easy-to-understand recommendations"
              >
                <span aria-hidden="true">☀</span> Simplified
              </button>
              <button
                type="button"
                className={`detail-mode-btn ${detailMode === 'detailed' ? 'active' : ''}`}
                onClick={() => setDetailMode('detailed')}
                aria-pressed={detailMode === 'detailed'}
                title="Technical, medical-grade information"
              >
                <span aria-hidden="true">⌕</span> Detailed
              </button>
            </div>
          </div>

          {records.length > 0 && (
            <div className="recommendations-summary" role="status">
              <span className="recommendations-summary__item">
                <strong>{counts.all}</strong> suggested
              </span>
              <span className="recommendations-summary__item">
                <strong>{addedCount}</strong> in your plan
              </span>
              {counts.high > 0 && (
                <span className="recommendations-summary__item recommendations-summary__item--high">
                  <strong>{counts.high}</strong> high priority
                </span>
              )}
            </div>
          )}
        </header>

        {showEvidenceInfo && <EvidenceInfoModal onClose={() => setShowEvidenceInfo(false)} />}

        {detailTarget && (
          <SupplementDetailModal
            supplementName={detailTarget.name}
            assessmentId="recommendations"
            context={detailTarget.context}
            cache={detailCache}
            onClose={() => setDetailTarget(null)}
          />
        )}

        {/* A consult-doctor trigger is computed server-side from the free-text
            feeling description. It is the one recommendation here that must not
            be skimmable, so it is a banner rather than a card. */}
        {consult && (
          <aside className="rec-consult" role="alert">
            <span className="rec-consult__icon" aria-hidden="true">✚</span>
            <div>
              <strong>Medical consultation recommended</strong>
              <p>{fixChars(consult.reason)}</p>
            </div>
          </aside>
        )}

        {records.length > 0 && (
          <div className="professional-warning">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p>
              These recommendations are AI-generated suggestions based on your assessment.
              Always consult with a healthcare professional before starting any new supplement regimen.
            </p>
          </div>
        )}

        {records.length > 0 && (
          <>
            <div className="rec-toolbar">
              <div className="filter-tabs" role="group" aria-label="Filter by priority">
                {PRIORITY_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`filter-tab ${activeTab === tab.key ? 'active' : ''}`}
                    onClick={() => setActiveTab(tab.key)}
                    aria-pressed={activeTab === tab.key}
                  >
                    {tab.label}
                    <span className="filter-tab__count">{counts[tab.key]}</span>
                  </button>
                ))}
              </div>

              <div className="rec-search">
                <label htmlFor="rec-search-input" className="visually-hidden">Search recommendations</label>
                <input
                  id="rec-search-input"
                  type="search"
                  value={query}
                  placeholder="Search supplements"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>

            {/* A live region, so filtering announces its result rather than
                silently changing what is on screen. */}
            <p className="rec-result-count" role="status">
              {sorted.length} {sorted.length === 1 ? 'recommendation' : 'recommendations'}
              {query.trim() && ' matching your search'}
            </p>
          </>
        )}

        <div className="recommendations-list">
          {showError && (
            <RecommendationsEmpty
              title="We could not load your recommendations"
              text={loadError}
              action="Try again"
              onAction={reload}
            />
          )}

          {showNoAssessment && (
            <RecommendationsEmpty
              title="No recommendations yet"
              text="Complete a health assessment and we'll generate personalized AI-powered supplement recommendations tailored to your needs."
              action="Take the assessment"
              onAction={() => navigate('/assessment')}
            />
          )}

          {showNoRecs && (
            <RecommendationsEmpty
              title="Your assessment is still being analysed"
              text="We couldn't find any recommendations saved for your latest assessment. If this persists, retaking the assessment will generate a fresh plan."
              action="Retake the assessment"
              onAction={() => navigate('/assessment')}
            />
          )}

          {showNoFilterMatches && (
            <RecommendationsEmpty
              title={query.trim() ? 'Nothing matches that search' : `Nothing at ${activeTab} priority`}
              text={
                query.trim()
                  ? 'Try a different supplement name, or clear the search to see everything we suggested.'
                  : 'No recommendations match this filter. Try another priority to see everything we suggested for you.'
              }
              action="Show all recommendations"
              onAction={() => { setActiveTab('all'); setQuery(''); }}
            />
          )}

          {visible.map((rec) => {
            const key = nameKey(recName(rec)) || String(recName(rec));
            return (
              <RecommendationCard
                key={key}
                rec={rec}
                expanded={expanded.has(key)}
                onToggle={() => toggleExpanded(key)}
                onOpenDetail={() => openDetail(rec)}
                detailMode={detailMode}
                onShowEvidenceInfo={() => setShowEvidenceInfo(true)}
                onPlanToggle={handlePlanToggle}
                onPlan={() => navigate('/track-intake')}
                busy={busyKey === key}
                added={isOnPlan(rec, planKeys)}
              />
            );
          })}
        </div>

        {sorted.length > INITIAL_VISIBLE && (
          <button
            type="button"
            className="btn-show-more"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
          >
            {showAll
              ? '▲ Show less'
              : `▼ Show ${sorted.length - INITIAL_VISIBLE} more`}
          </button>
        )}
      </div>
    </div>
  );
}

export default RecommendationsPage;
