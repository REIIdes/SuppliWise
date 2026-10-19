import { useState, useEffect } from 'react';
import { BASE_URL, parseJSON } from '../../api';
import './MedicalReviewsPanel.css';

function MedicalReviewsPanel({ onRefreshRequest }) {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [resolving, setResolving] = useState(null);
  const [notes, setNotes] = useState({});

  // Direct API call since medical-review routes aren't under /api/admin
  const directRequest = async (path, options = {}) => {
    // Admin token is stored in localStorage as 'adminToken', not sessionStorage as 'admin_token'
    const token = localStorage.getItem('adminToken');
    if (!token) {
      throw new Error('No admin token found');
    }
    const url = `${BASE_URL}${path}`;
    console.log('[directRequest] URL:', url);
    console.log('[directRequest] Token:', token ? 'present' : 'missing');
    
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    
    console.log('[directRequest] Response status:', res.status);
    const data = await parseJSON(res);
    console.log('[directRequest] Response data:', data);
    
    if (!res.ok) throw new Error(data.message || 'Request failed');
    return data;
  };

  const loadReviews = async () => {
    try {
      const data = await directRequest('/medical-review/admin/reviews');
      setReviews(data.reviews || []);
      setError('');
    } catch (err) {
      console.error('Failed to load medical reviews:', err);
      setError(err.message || 'Failed to load medical reviews');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadReviews is async: every write lands after the fetch settles, and the interval below needs the same un-memoized loader
    loadReviews();
    // Auto-refresh every 30 seconds
    const interval = setInterval(loadReviews, 30000);
    return () => clearInterval(interval);
  }, []);

  // Expose loadReviews to parent via callback
  useEffect(() => {
    if (onRefreshRequest) {
      onRefreshRequest(loadReviews);
    }
  }, [onRefreshRequest]);

  const handleResolve = async (userId, decision) => {
    if (resolving) return;
    
    const reviewNotes = notes[userId] || '';
    if (!reviewNotes.trim()) {
      alert('Please add notes before resolving this review.');
      return;
    }

    try {
      setResolving(userId);
      const result = await directRequest(`/medical-review/admin/reviews/${userId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision, notes: reviewNotes }),
      });
      
      console.log('Resolve success:', result);
      
      // Remove from list
      setReviews(prev => prev.filter(r => r.userId !== userId));
      setExpandedId(null);
      setNotes(prev => {
        const updated = { ...prev };
        delete updated[userId];
        return updated;
      });
    } catch (err) {
      console.error('Failed to resolve review:', err);
      alert(`Failed to resolve review: ${err.message}`);
    } finally {
      setResolving(null);
    }
  };

  const handleNotesChange = (userId, value) => {
    setNotes(prev => ({ ...prev, [userId]: value }));
  };

  if (loading && reviews.length === 0) {
    return (
      <div className="medical-reviews-loading">
        <div className="loading-spinner"></div>
        <p>Loading medical reviews...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="medical-reviews-error">
        <p className="error-message">{error}</p>
        <button className="btn-retry" onClick={loadReviews}>Retry</button>
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="medical-reviews-empty">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <h3>No Pending Medical Reviews</h3>
        <p>All medical review requests have been processed.</p>
      </div>
    );
  }

  return (
    <div className="medical-reviews-panel">
      <div className="medical-reviews-header">
        <h2>Pending Medical Reviews ({reviews.length})</h2>
      </div>

      <div className="medical-reviews-list">
        {reviews.map((review) => {
          const isExpanded = expandedId === review.userId;
          const isResolving = resolving === review.userId;

          return (
            <div key={review.userId} className={`medical-review-card ${isExpanded ? 'expanded' : ''}`}>
              <div className="review-card-header" onClick={() => setExpandedId(isExpanded ? null : review.userId)}>
                <div className="review-user-info">
                  <div className="review-user-name">
                    {review.firstName} {review.lastName}
                  </div>
                  <div className="review-user-email">{review.email}</div>
                </div>
                <div className="review-meta">
                  <div className="review-date">
                    Requested: {new Date(review.requestedAt).toLocaleDateString()}
                  </div>
                  <button className="review-expand-btn" aria-label={isExpanded ? 'Collapse' : 'Expand'}>
                    <svg className={`chevron ${isExpanded ? 'rotated' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="review-card-body">
                  {review.assessment ? (
                    <div className="review-assessment-details">
                      <h4>Flagged Assessment Details</h4>
                      <div className="review-detail-group">
                        <label>Flagged Date:</label>
                        <span>{new Date(review.assessment.flaggedAt).toLocaleString()}</span>
                      </div>
                      <div className="review-detail-group">
                        <label>Concerning Symptoms/Reasons:</label>
                        <ul className="review-reasons-list">
                          {(review.assessment.flagReasons || []).map((reason, idx) => (
                            <li key={idx}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                      {review.assessment.symptoms && review.assessment.symptoms.length > 0 && (
                        <div className="review-detail-group">
                          <label>Reported Symptoms:</label>
                          <div className="review-symptoms">
                            {review.assessment.symptoms.slice(0, 10).map((symptom, idx) => (
                              <span key={idx} className="symptom-pill">{symptom}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {review.assessment.medicalConditions && review.assessment.medicalConditions.length > 0 && (
                        <div className="review-detail-group">
                          <label>Medical Conditions:</label>
                          <div className="review-conditions">
                            {review.assessment.medicalConditions.map((condition, idx) => (
                              <span key={idx} className="condition-pill">{condition}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="review-no-assessment">
                      <p>No flagged assessment found for this user.</p>
                    </div>
                  )}

                  <div className="review-admin-notes">
                    <label htmlFor={`notes-${review.userId}`}>Admin Notes (required):</label>
                    <textarea
                      id={`notes-${review.userId}`}
                      value={notes[review.userId] || ''}
                      onChange={(e) => handleNotesChange(review.userId, e.target.value)}
                      placeholder="Enter notes about this review (e.g., medical clearance provided, contacted user, etc.)"
                      rows="4"
                      disabled={isResolving}
                    />
                  </div>

                  <div className="review-actions">
                    <button
                      className="btn-approve"
                      onClick={() => handleResolve(review.userId, 'approved')}
                      disabled={isResolving || !notes[review.userId]?.trim()}
                    >
                      {isResolving ? 'Processing...' : 'Approve & Lift Block'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MedicalReviewsPanel;
