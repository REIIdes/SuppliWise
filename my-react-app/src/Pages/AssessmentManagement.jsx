import { useState, useEffect, useRef } from 'react';
import { BASE_URL, parseJSON } from '../api';
import { exportResultsToPDF } from '../utils/exportPDF';
import './AssessmentManagement.css';
import AssessmentResultsDisplay from '../Components/AssessmentResultsDisplay/AssessmentResultsDisplay';
import ModifyAssessmentModal from '../Components/ModifyAssessmentModal/ModifyAssessmentModal';
import ReadOnlyAssessment from '../Components/ReadOnlyAssessment/ReadOnlyAssessment';

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
      <div className="am-list-header">
        <span className="am-list-count">
          {users.length} {users.length === 1 ? 'user' : 'users'}
        </span>
        <button
          type="button"
          className="am-refresh-btn"
          onClick={loadUsers}
          disabled={isLoading}
          title="Reload the user list"
        >
          {isLoading ? 'Loading…' : '↻ Refresh'}
        </button>
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
          <p className="am-empty">Loading users…</p>
        ) : users && users.length > 0 ? (
          users.map((user) => {
            const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown';
            const initials = fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const isOpen = expandedUser === user._id;

            // Deterministic avatar colour from name
            const palette = ['#0891b2','#4f6bed','#2e9e6b','#d46b35','#7c4ddb','#e85d75','#b45309','#be185d'];
            let hash = 0;
            for (let i = 0; i < fullName.length; i++) hash = fullName.charCodeAt(i) + ((hash << 5) - hash);
            const avatarBg = palette[Math.abs(hash) % palette.length];

            return (
              <div key={user._id} className={`am-user-item${isOpen ? ' am-user-item--open' : ''}`}>
                {/* ── User row ──────────────────────────────────────── */}
                <button
                  className="am-user-row"
                  onClick={() => handleUserToggle(user._id)}
                  aria-expanded={isOpen}
                >
                  {/* Avatar */}
                  {user.profilePicture ? (
                    <img
                      className="am-avatar"
                      src={user.profilePicture}
                      alt={fullName}
                      onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
                    />
                  ) : null}
                  <span
                    className="am-avatar am-avatar--initials"
                    style={{ background: avatarBg, display: user.profilePicture ? 'none' : 'flex' }}
                    aria-hidden="true"
                  >
                    {initials}
                  </span>

                  {/* Name + joined */}
                  <span className="am-user-info">
                    <span className="am-user-name">{fullName}</span>
                    <span className="am-user-sub">Joined: {new Date(user.createdAt).toLocaleDateString()}</span>
                  </span>

                  {/* Assessment count pill */}
                  <span className="am-count-pill">
                    {user.assessmentCount ?? 0} {(user.assessmentCount ?? 0) === 1 ? 'assessment' : 'assessments'}
                  </span>

                  {/* Chevron */}
                  <span className={`am-chevron${isOpen ? ' am-chevron--open' : ''}`} aria-hidden="true">▼</span>
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
                                  className="am-btn am-btn--blue"
                                  onClick={() => generatePDF(assessment)}
                                  disabled={Boolean(pdfLoadingId)}
                                  aria-busy={pdfLoadingId === assessment._id}
                                  aria-label={`${pdfLoadingId === assessment._id ? 'Generating' : 'Generate'} PDF for ${assessment.userName || fullName}`}
                                >
                                  {pdfLoadingId === assessment._id ? 'Preparing…' : 'PDF'}
                                </button>
                                <button className="am-btn am-btn--blue"   onClick={() => setModifiedAssessment(assessment)}>Modify</button>
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
          <div className="am-empty">
            <p>{listError}</p>
            <button type="button" className="am-retry-btn" onClick={loadUsers} disabled={isLoading}>
              {isLoading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        ) : (
          <p className="am-empty">No users found.</p>
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