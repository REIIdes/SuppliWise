import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { BASE_URL, parseJSON } from '../api';
import { exportResultsToPDF } from '../utils/exportPDF';
import { pictureUrl } from '../utils/pictureUrl';
import { formatShortDate } from '../utils/dates';
import './AssessmentManagement.css';
import AssessmentResultsDisplay from '../Components/AssessmentResultsDisplay/AssessmentResultsDisplay';
import ModifyAssessmentModal from '../Components/ModifyAssessmentModal/ModifyAssessmentModal';
import ReadOnlyAssessment from '../Components/ReadOnlyAssessment/ReadOnlyAssessment';

/* Avatar gradients. A stable hue per member means the same face keeps the same
   colour everywhere in the console, which is what makes a list scannable. The
   previous version picked a FLAT colour from a palette, so a long list came out
   looking like the same blue dot repeated. */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f97316 0%, #e11d48 100%)',
  'linear-gradient(135deg, #4f6bed 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #10b981 0%, #0d9488 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
  'linear-gradient(135deg, #f43f5e 0%, #f59e0b 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
];

/** Hashed off the id when there is one, so a renamed member keeps their colour. */
function avatarGradient(user) {
  const seed = String(user?._id || user?.email || user?.firstName || 'x');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

const ICONS = {
  users: <><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.4 3.4 0 0 1 0 6.6" /><path d="M18 14.2A6.5 6.5 0 0 1 21.5 20" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  clipboard: <><rect x="8" y="3" width="8" height="4" rx="1.4" /><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /><path d="M8.5 12h7M8.5 16h4" /></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  empty: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></>,
};

function StatIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const AssessmentManagement = ({ users: propUsers = [] }) => {
  const [users, setUsers] = useState(propUsers);
  const [assessments, setAssessments] = useState([]);
  const [selectedAssessment, setSelectedAssessment] = useState(null);
  const [modifiedAssessment, setModifiedAssessment] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingAssessments, setIsLoadingAssessments] = useState(false);
  const [assessmentResults, setAssessmentResults] = useState(null);
  const [expandedUser, setExpandedUser] = useState(null);
  const [listError, setListError] = useState('');
  const [pdfLoadingId, setPdfLoadingId] = useState(null);
  const [pdfError, setPdfError] = useState('');
  // Client-side filter over the list the parent already fetched. There was no
  // search here at all, which makes the tab unusable at any real member count —
  // an administrator had to scroll and expand every row to find one person.
  const [search, setSearch] = useState('');
  // Ids whose picture failed to load, so the initials fallback is driven by
  // state rather than by reaching into `nextSibling` from an onError handler.
  const [brokenPictures, setBrokenPictures] = useState(() => new Set());

  const markPictureBroken = useCallback((id) => {
    setBrokenPictures((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, []);

  // Hits /api/assessment/... directly with the admin token
  const assessmentRequest = async (path) => {
    const res = await fetch(`${BASE_URL}/assessment${path}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
    });
    const data = await parseJSON(res);
    if (!res.ok) throw new Error(data?.message || 'Request failed');
    return data;
  };

  // Self-sufficient user list — the standalone /admin/assessment-management
  // route renders this component with no props, so fetch when none provided.
  const loadUsers = async () => {
    setIsLoading(true);
    setListError('');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${BASE_URL}/admin/users?search=`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
        signal: controller.signal,
      });
      const data = await parseJSON(res);
      if (!res.ok) throw new Error(data?.message || 'Could not load users.');
      setUsers(data.users || []);
    } catch (err) {
      setListError(err.name === 'AbortError'
        ? 'Loading users timed out. Please check your connection and retry.'
        : (err.message || 'Could not load users.'));
    } finally {
      clearTimeout(timer);
      setIsLoading(false);
    }
  };

  // Initial load when the parent did not supply a user list
  useEffect(() => {
    if (!propUsers || propUsers.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial list load on mount
      loadUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync if parent re-fetches and passes a new list
  useEffect(() => {
    if (propUsers && propUsers.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional prop sync when parent reloads
      setUsers(propUsers);
      setIsLoading(false);
    }
  }, [propUsers]);

  // Realtime sync: re-pull the expanded user's assessments when the tab
  // regains focus (catches auto-lift/reflag that happened elsewhere)
  const expandedRef = useRef(null);
  useEffect(() => {
    expandedRef.current = expandedUser;
  }, [expandedUser]);
  useEffect(() => {
    const onVisible = () => {
      const id = expandedRef.current;
      if (document.visibilityState === 'visible' && id) {
        assessmentRequest(`/user/${id}`)
          .then(data => setAssessments(data))
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const handleUserToggle = async (userId) => {
    if (expandedUser === userId) {
      setExpandedUser(null);
      setAssessments([]);
    } else {
      setExpandedUser(userId);
      setAssessments([]); // clear previous user's list immediately — never show stale data
      setIsLoadingAssessments(true);
      try {
        const data = await assessmentRequest(`/user/${userId}`);
        setAssessments(data);
      } catch (error) {
        console.error('Error fetching assessments:', error);
      } finally {
        setIsLoadingAssessments(false);
      }
    }
  };

  const handleViewResults = async (assessmentId) => {
    try {
      const data = await assessmentRequest(`/results/${assessmentId}`);
      setAssessmentResults(data);
    } catch (error) {
      console.error('Error fetching assessment results:', error);
    }
  };

  const generatePDF = async (assessment) => {
    if (!assessment?._id || pdfLoadingId) return;
    const user = users.find((candidate) => candidate._id === assessment.user);
    const userName = String(assessment.userName || '').trim()
      || [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
      || 'Unknown member';

    setPdfLoadingId(assessment._id);
    setPdfError('');
    try {
      const result = await assessmentRequest(`/results/${assessment._id}`);
      if (!result || typeof result !== 'object') {
        throw new Error('This assessment does not have an AI report yet.');
      }

      // Use the canonical assessment snapshot when available.  This keeps the
      // report's identity and date stable even if the admin user list changes.
      const reportAssessment = {
        ...assessment,
        userName,
        createdAt: assessment.createdAt || new Date().toISOString(),
      };
      const generated = await exportResultsToPDF(result, reportAssessment);
      if (!generated) throw new Error('The report could not be generated. Please try again.');
    } catch (error) {
      console.error('Error generating assessment PDF:', error);
      setPdfError(error?.message || 'Unable to generate the report.');
    } finally {
      setPdfLoadingId(null);
    }
  };

  const handleViewAssessment = (assessment) => {
    setSelectedAssessment(assessment);
  };

  // ── Derived ─────────────────────────────────────────────────────────────
  // The counts an administrator opens this tab to answer: how many members are
  // there, how many have actually been assessed, and how much there is to read.
  // The old header said only "2 users", which answers none of those.
  const stats = useMemo(() => {
    const total = users?.length || 0;
    const withAssessments = (users || []).filter((u) => Number(u.assessmentCount) > 0).length;
    const totalAssessments = (users || []).reduce((sum, u) => sum + (Number(u.assessmentCount) || 0), 0);
    const avg = withAssessments > 0 ? (totalAssessments / withAssessments) : 0;
    return { total, withAssessments, totalAssessments, avg: avg.toFixed(1) };
  }, [users]);

  const visibleUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users || [];
    return (users || []).filter((user) => {
      const name = `${user.firstName || ''} ${user.lastName || ''}`.trim().toLowerCase();
      return name.includes(term) || String(user.email || '').toLowerCase().includes(term);
    });
  }, [users, search]);

  const statCards = [
    { tone: 'all', icon: 'users', label: 'Members', value: stats.total, hint: 'On this account' },
    { tone: 'ok', icon: 'check', label: 'Assessed', value: stats.withAssessments, hint: 'Have at least one' },
    { tone: 'primary', icon: 'clipboard', label: 'Assessments', value: stats.totalAssessments, hint: 'Total on record' },
    { tone: 'down', icon: 'chart', label: 'Average', value: stats.avg, hint: 'Per assessed member' },
  ];

  const deleteAssessment = async (assessmentId) => {
    // Remove from local state immediately (modal already confirmed + called API)
    setAssessments(prev => prev.filter(a => a._id !== assessmentId));
    setModifiedAssessment(null);
  };

  const saveModifiedAssessment = async (updatedAssessment) => {
    // The modal already called the API — just update local state and close
    setAssessments(prev =>
      prev.map(a => a._id === updatedAssessment._id ? { ...a, ...updatedAssessment } : a)
    );
    setModifiedAssessment(null);
  };

  return (
    <div className="am-container">
      <header className="am-head">
        <div>
          <h3 className="am-head__title">Assessment Management</h3>
          <p className="am-head__sub">
            Every member&rsquo;s assessments, newest first. Open a member to read results,
            export a report, or correct what was recorded.
          </p>
        </div>
        <button
          type="button"
          className={`am-refresh-btn${isLoading ? ' am-refresh-btn--busy' : ''}`}
          onClick={loadUsers}
          disabled={isLoading}
          title="Reload the member list"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
          </svg>
          {isLoading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      <div className="am-stats" role="group" aria-label="Assessment totals">
        {statCards.map((card) => (
          <div className={`am-stat am-stat--${card.tone}`} key={card.tone}>
            <span className="am-stat__icon" aria-hidden="true"><StatIcon name={card.icon} /></span>
            <span className="am-stat__body">
              <span className="am-stat__value">{card.value}</span>
              <span className="am-stat__label">{card.label}</span>
              <span className="am-stat__hint">{card.hint}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="am-list-header">
        <span className="am-list-count">
          {visibleUsers.length} of {stats.total} {stats.total === 1 ? 'member' : 'members'}
        </span>
        <div className="am-field">
          <svg className="am-field__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
          </svg>
          <input
            type="search"
            className="am-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email…"
            aria-label="Filter members by name or email"
          />
        </div>
      </div>
      {pdfError && (
        <div className="am-pdf-error" role="alert">
          <span aria-hidden="true">!</span>
          <p>{pdfError}</p>
          <button type="button" onClick={() => setPdfError('')} aria-label="Dismiss report error">×</button>
        </div>
      )}
      <div className="am-user-list">
        {isLoading ? (
          <div className="am-skeletons" aria-hidden="true">
            {[0, 1, 2, 3].map((n) => (
              <div className="am-skeleton" key={n}>
                <span className="am-skeleton__avatar" />
                <span className="am-skeleton__lines">
                  <span className="am-skeleton__line am-skeleton__line--sm" />
                  <span className="am-skeleton__line" />
                </span>
                <span className="am-skeleton__pill" />
              </div>
            ))}
          </div>
        ) : visibleUsers.length > 0 ? (
          visibleUsers.map((user) => {
            const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown';
            const initials = fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const isOpen = expandedUser === user._id;
            const count = Number(user.assessmentCount) || 0;

            // Stored pictures are root-relative paths; resolved against the API
            // origin or the <img> would request them from the SPA's own origin
            // and 404 into the initials fallback.
            const avatarSrc = pictureUrl(user.profilePicture);
            const showPicture = Boolean(avatarSrc) && !brokenPictures.has(user._id);

            return (
              <div key={user._id} className={`am-user-item${isOpen ? ' am-user-item--open' : ''}`}>
                {/* ── User row ──────────────────────────────────────── */}
                <button
                  className="am-user-row"
                  onClick={() => handleUserToggle(user._id)}
                  aria-expanded={isOpen}
                >
                  {/* Avatar. A broken or absent picture falls back to the
                      initials, which is what a state flag decides now — the old
                      onError reached into `nextSibling` and would throw if the
                      DOM order ever changed. */}
                  {showPicture ? (
                    <img
                      className="am-avatar"
                      src={avatarSrc}
                      alt={fullName}
                      onError={() => markPictureBroken(user._id)}
                    />
                  ) : null}
                  <span
                    className="am-avatar am-avatar--initials"
                    style={{ backgroundImage: avatarGradient(user), display: showPicture ? 'none' : 'flex' }}
                    aria-hidden="true"
                  >
                    {initials}
                  </span>

                  {/* Name + joined */}
                  <span className="am-user-info">
                    <span className="am-user-name">{fullName}</span>
                    <span className="am-user-sub">
                      {/* formatShortDate, not a bare toLocaleDateString: rows
                          imported without a createdAt used to print the literal
                          string "Invalid Date" in the admin console. */}
                      {user.email ? `${user.email} · ` : ''}Joined {formatShortDate(user.createdAt)}
                    </span>
                  </span>

                  {/* Assessment count pill — green when there is something to
                      read, muted when there is not, so the members who need
                      attention stand out instead of the empty ones. */}
                  <span className={`am-count-pill${count > 0 ? ' am-count-pill--has' : ' am-count-pill--none'}`}>
                    {count} {count === 1 ? 'assessment' : 'assessments'}
                  </span>

                  {/* Chevron */}
                  <span className={`am-chevron${isOpen ? ' am-chevron--open' : ''}`} aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </button>

                {/* ── Assessment cards ───────────────────────────── */}
                {isOpen && (
                  <div className="am-assessment-list">
                    {isLoadingAssessments ? (
                      <p className="am-empty">Loading assessments…</p>
                    ) : assessments.length === 0 ? (
                      <p className="am-empty">No assessments found for this user.</p>
                    ) : (
                      assessments.map((assessment) => {
                        const isPriority = assessment.priority === 'Priority';
                        // Real expiry — assessment.expiresAt, else the fallback
                        // createdAt + 5 calendar years (same advance the server
                        // writes). Priority assessments never expire while
                        // flagged, so they carry no expiry at all.
                        const expiryDate = isPriority
                          ? null
                          : assessment.expiresAt
                            ? new Date(assessment.expiresAt)
                            : (() => { const d = new Date(assessment.createdAt); d.setFullYear(d.getFullYear() + 5); return d; })();
                        const isExpiredRecord = !isPriority
                          && !!expiryDate
                          && Number.isFinite(expiryDate.getTime())
                          && expiryDate.getTime() <= Date.now();

                        return (
                          <div key={assessment._id} className="am-card">
                            {/* Card header */}
                            <div className="am-card__header">
                              {isExpiredRecord ? (
                                <span className="am-pill am-pill--expired" title="Expired — record kept for reference">EXPIRED</span>
                              ) : (
                                <span className="am-pill am-pill--active">ACTIVE</span>
                              )}
                              {isPriority && (
                                <span
                                  className="am-pill am-pill--priority"
                                  title={(assessment.flagReasons || []).join('; ') || 'Flagged as priority'}
                                >
                                  ⚑ PRIORITY
                                </span>
                              )}
                              <span className="am-card__date">
                                {new Date(assessment.createdAt).toLocaleString()}
                              </span>
                            </div>
                            {isPriority && Array.isArray(assessment.flagReasons) && assessment.flagReasons.length > 0 && (
                              <p className="am-card__flag-reasons">
                                Flagged: {assessment.flagReasons.join('; ')}
                              </p>
                            )}

                            {/* Symptoms summary */}
                            <p className="am-card__symptoms">
                              {Array.isArray(assessment.symptoms) && assessment.symptoms.length > 0
                                ? assessment.symptoms.join(', ')
                                : 'No symptoms recorded'}
                            </p>

                            {/* Tag pills */}
                            <div className="am-tags">
                              {assessment.age && (
                                <span className="am-tag">Age {assessment.age}</span>
                              )}
                              {assessment.dietType && (
                                <span className="am-tag">{assessment.dietType}</span>
                              )}
                              {assessment.activityLevel && (
                                <span className="am-tag">{assessment.activityLevel}</span>
                              )}
                              {Array.isArray(assessment.symptoms) && assessment.symptoms.length > 0 && (
                                <span className="am-tag am-tag--green">
                                  {assessment.symptoms.length} symptom{assessment.symptoms.length !== 1 ? 's' : ''}
                                </span>
                              )}
                              {assessment.aiResults && (
                                <span className="am-tag am-tag--blue">✓ AI Analysis</span>
                              )}
                            </div>

                            {/* Footer */}
                            <div className="am-card__footer">
                              <span className="am-card__expiry">
                                {isPriority
                                  ? 'No expiry — resolves on completion'
                                  : isExpiredRecord
                                    ? `Expired ${expiryDate.toLocaleString()}`
                                    : expiryDate
                                      ? `Expires ${expiryDate.toLocaleString()}`
                                      : ''}
                              </span>
                              <div className="am-actions">
                                <button className="am-btn am-btn--grey"   onClick={() => handleViewAssessment(assessment)}>View</button>
                                <button className="am-btn am-btn--blue"   onClick={() => handleViewResults(assessment._id)}>Results</button>
                                <button
                                  className="am-btn am-btn--green"
                                  onClick={() => generatePDF(assessment)}
                                  disabled={Boolean(pdfLoadingId)}
                                  aria-busy={pdfLoadingId === assessment._id}
                                  aria-label={`${pdfLoadingId === assessment._id ? 'Generating' : 'Generate'} PDF for ${assessment.userName || fullName}`}
                                >
                                  {pdfLoadingId === assessment._id ? 'Preparing…' : 'PDF'}
                                </button>
                                <button className="am-btn am-btn--violet"   onClick={() => setModifiedAssessment(assessment)}>Modify</button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        ) : listError ? (
          <div className="am-empty am-empty--state">
            <span className="am-empty__icon am-empty__icon--error" aria-hidden="true">
              <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" />
              </svg>
            </span>
            <p className="am-empty__title">Could not load members</p>
            <p className="am-empty__text">{listError}</p>
            <button type="button" className="am-retry-btn" onClick={loadUsers} disabled={isLoading}>
              {isLoading ? 'Retrying…' : 'Try again'}
            </button>
          </div>
        ) : search.trim() ? (
          <div className="am-empty am-empty--state">
            <span className="am-empty__icon" aria-hidden="true"><StatIcon name="empty" /></span>
            <p className="am-empty__title">No members match</p>
            <p className="am-empty__text">Nothing matches “{search.trim()}”.</p>
            <button type="button" className="am-retry-btn" onClick={() => setSearch('')}>
              Clear search
            </button>
          </div>
        ) : (
          <div className="am-empty am-empty--state">
            <span className="am-empty__icon" aria-hidden="true"><StatIcon name="users" /></span>
            <p className="am-empty__title">No members yet</p>
            <p className="am-empty__text">Members appear here as soon as they register.</p>
          </div>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────── */}
      {selectedAssessment && (
        <div className="am-modal" onClick={e => e.target === e.currentTarget && setSelectedAssessment(null)}>
          <div className="am-modal__content">
            <ReadOnlyAssessment
              assessment={selectedAssessment}
              onClose={() => setSelectedAssessment(null)}
            />
          </div>
        </div>
      )}
      {assessmentResults && (
        <div className="am-modal" onClick={e => e.target === e.currentTarget && setAssessmentResults(null)}>
          <div className="am-modal__content">
            <button className="am-modal__close" onClick={() => setAssessmentResults(null)} aria-label="Close">&times;</button>
            <AssessmentResultsDisplay results={assessmentResults} />
          </div>
        </div>
      )}
      {modifiedAssessment && (
        <ModifyAssessmentModal
          assessment={modifiedAssessment}
          onClose={() => setModifiedAssessment(null)}
          onSave={saveModifiedAssessment}
          onDelete={deleteAssessment}
        />
      )}
    </div>
  );
};

export default AssessmentManagement;