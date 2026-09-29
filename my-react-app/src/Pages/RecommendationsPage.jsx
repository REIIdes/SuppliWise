import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import { getHistory, addSupplementToPlan, removeSupplementFromPlan, getMyPlan, getToken } from '../api';
import './RecommendationsPage.css';

/* The "nothing to show" panel. This was two ~40-line blocks of inline styles
   that were byte-for-byte identical except for the paragraph, and neither
   offered a way out — a member whose assessment had not been analysed yet
   was told to go and complete one, with no link to do it. One component, one
   set of classes, and the action is part of the contract so it cannot be
   forgotten again. */
function RecommendationEmpty({ title, text, action, onAction }) {
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
        <button type="button" className="sw-btn" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function RecommendationsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState(null);
  const [activeTab, setActiveTab] = useState('all');
  const [addedSupplements, setAddedSupplements] = useState(new Set());
  const [addingSupplementId, setAddingSupplementId] = useState(null);
  const [toast, setToast] = useState('');
  const [toastKey, setToastKey] = useState(0);
  const toastTimerRef = useRef(null);

  const fetchMyPlan = async () => {
    try {
      const planData = await getMyPlan();
      const supplementNames = new Set(planData.supplements.map(s => s.name));
      setAddedSupplements(supplementNames);
    } catch (err) {
      console.error('Error fetching my plan:', err);
      // Don't show error to user, just fail silently
    }
  };

  const fetchLatestRecommendations = async () => {
    try {
      // Lightweight fetch — only recommendations, not the full AI blob
      const historyData = await getHistory(1, 1, 'recommendations');

      if (historyData.assessments && historyData.assessments.length > 0) {
        const latestAssessment = historyData.assessments[0];

        if (latestAssessment.aiResults?.recommendations) {
          setRecommendations(latestAssessment.aiResults.recommendations);
        } else {
          // No recommendations but show empty state UI
          setRecommendations([]);
        }
      } else {
        // No assessments but show empty state UI
        setRecommendations([]);
      }
    } catch (err) {
      console.error('Error fetching recommendations:', err);
      // Show empty state instead of error
      setRecommendations([]);
    }
  };

  // Initial parallel load on mount + auth guard
  useEffect(() => {
    const token = getToken();
    if (!token) {
      navigate('/login');
      return;
    }

    // Fetch both in parallel and wait for both to complete
    const fetchData = async () => {
      setLoading(true);
      setRecommendations(null); // Clear old data immediately
      setAddedSupplements(new Set()); // Clear old "added" state immediately

      await Promise.all([
        fetchLatestRecommendations(),
        fetchMyPlan()
      ]);

      setLoading(false); // Only set loading false after BOTH complete
    };

    fetchData();

    // Cleanup timer on unmount
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, [navigate]);

  const getFilteredRecommendations = () => {
    if (!recommendations) return [];

    // Sort by: added status (not added first, added last), then priority
    // (High → Medium → Low), then confidence score.
    //
    // The order table used to be keyed `High`/`Medium`/`Low` while the API
    // returns 'high'/'medium'/'low'. Every lookup missed, every item fell
    // through to the `?? 3` default, and since they were ALL 3 the priority
    // clause was always 0 — so the list silently sorted by confidence only
    // and a "low" recommendation could appear above a "high" one. The keys
    // are matched case-insensitively now, via priorityOf above.
    const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
    const sorted = [...recommendations].sort((a, b) => {
      const aName = a.name || a.supplement;
      const bName = b.name || b.supplement;
      const aAdded = addedSupplements.has(aName);
      const bAdded = addedSupplements.has(bName);

      // First: added status (not added first, added last)
      if (aAdded !== bAdded) return aAdded ? 1 : -1;

      // Then: priority (High → Medium → Low)
      const pa = PRIORITY_ORDER[priorityOf(a.priority)];
      const pb = PRIORITY_ORDER[priorityOf(b.priority)];
      if (pa !== pb) return pa - pb;

      // Finally: confidence score descending
      return (b.confidenceScore || 0) - (a.confidenceScore || 0);
    });

    if (activeTab === 'all') return sorted;

    return sorted.filter(rec => {
      const priority = rec.priority?.toLowerCase();
      return priority === activeTab;
    });
  };

  /* One source for "what priority is this?", used by the badge, the card's
     accent rail and the list sort. It used to be a switch that returned
     'medium' for anything unrecognised — including an absent priority — which
     is why a card with no priority at all rendered a "medium priority" badge
     rather than admitting it had none. `low` is the safe floor: it is the
     least-prominent tone, so a card is never styled as important by accident. */
  const priorityOf = (priority) => {
    const key = String(priority || '').toLowerCase();
    return key === 'high' || key === 'medium' || key === 'low' ? key : 'low';
  };

  const getPriorityBadgeClass = (priority) => `priority-badge-${priorityOf(priority)}`;

  /* Returns the bare tone (`high`), not `card--high` — the call site already
     writes `recommendation-card--${…}`, and doing it in both places produced
     `recommendation-card--card--high`, which matched no rule and silently left
     every card's accent rail and priority dot on the neutral fallback. */
  const cardTone = (priority) => priorityOf(priority);

  const showToast = (message) => {
    // Clear any existing timer
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    
    // Show new toast with new key to force re-animation
    setToast(message);
    setToastKey(prev => prev + 1); // Increment key to force re-mount and animation
    
    // Set new timer
    toastTimerRef.current = setTimeout(() => {
      setToast('');
      toastTimerRef.current = null;
    }, 2000);
  };

  const handleAddToPlan = async (supplement) => {
    try {
      const supplementName = supplement.name || supplement.supplement;
      setAddingSupplementId(supplementName);
      
      // Check if already added - if so, remove it (toggle behavior)
      if (addedSupplements.has(supplementName)) {
        await removeSupplementFromPlan(supplementName);
        setAddedSupplements(prev => {
          const newSet = new Set(prev);
          newSet.delete(supplementName);
          return newSet;
        });
        showToast(`✓ ${supplementName} removed from your plan`);
      } else {
        // Add to plan
        const supplementData = {
          name: supplementName,
          dosage: supplement.dosage || '',
          timing: supplement.timing || 'Anytime',
          priority: supplement.priority || 'Medium',
        };

        await addSupplementToPlan(supplementData);
        
        setAddedSupplements(prev => new Set([...prev, supplementData.name]));
        showToast(`✓ ${supplementData.name} added to your plan!`);
      }
    } catch (err) {
      console.error('Error updating plan:', err);
      showToast(`Failed to update plan. Please try again.`);
    } finally {
      setAddingSupplementId(null);
    }
  };

  const isSupplementAdded = (supplementName) => {
    return addedSupplements.has(supplementName);
  };

  if (loading) {
    return (
      <div className="recommendations-wrapper">
        <Navbar />
        <div className="recommendations-loading-simple">
          <div className="loading-spinner-simple"></div>
        </div>
      </div>
    );
  }

  const filteredRecommendations = getFilteredRecommendations();

  return (
    <div className="recommendations-wrapper">
      <Navbar />
      
      {/* Toast notification */}
      {toast && (
        <Toast 
          key={toastKey}
          message={toast} 
          type="success" 
          duration={2000}
          onClose={() => setToast('')}
        />
      )}
      
      <div className="recommendations-container">
        {/* Header */}
        <div className="recommendations-header">
          <h1 className="recommendations-title">AI-Powered Recommendations</h1>
          <p className="recommendations-subtitle">Personalized supplement suggestions based on your health assessment</p>
        </div>

        {/* Professional Consultation Warning - Only show when there are recommendations */}
        {recommendations && recommendations.length > 0 && (
          <div className="professional-warning">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <p>These recommendations are AI-generated suggestions based on your assessment. Always consult with a healthcare professional before starting any new supplement regimen.</p>
          </div>
        )}

        {/* Recommendations List */}
        <div className="filter-tabs">
          <button 
            className={`filter-tab ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            All Recommendations
          </button>
          <button 
            className={`filter-tab ${activeTab === 'high' ? 'active' : ''}`}
            onClick={() => setActiveTab('high')}
          >
            High priority
          </button>
          <button 
            className={`filter-tab ${activeTab === 'medium' ? 'active' : ''}`}
            onClick={() => setActiveTab('medium')}
          >
            Medium priority
          </button>
          <button 
            className={`filter-tab ${activeTab === 'low' ? 'active' : ''}`}
            onClick={() => setActiveTab('low')}
          >
            Low priority
          </button>
        </div>

        {/* Recommendations List */}
        <div className="recommendations-list">
          {recommendations === null || (recommendations.length === 0 && activeTab === 'all') ? (
            <RecommendationEmpty
              title="No recommendations yet"
              text="Complete a health assessment and we'll generate personalized AI-powered supplement recommendations tailored to your needs."
              action="Take the assessment"
              onAction={() => navigate('/assessment')}
            />
          ) : filteredRecommendations.length === 0 ? (
            <RecommendationEmpty
              title={`Nothing at ${activeTab} priority`}
              text="No recommendations match this filter. Try another priority to see everything we suggested for you."
              action="Show all recommendations"
              onAction={() => setActiveTab('all')}
            />
          ) : (
            filteredRecommendations.map((rec, index) => (
              <div key={index} className={`recommendation-card recommendation-card--${cardTone(rec.priority)}`}>
                <div className="recommendation-header">
                  <div className="recommendation-title-row">
                    <h3 className="recommendation-name">{rec.name || 'Supplement'}</h3>
                    <span className={`priority-badge ${getPriorityBadgeClass(rec.priority)}`}>
                      {rec.priority || 'medium'} priority
                    </span>
                  </div>
                </div>

                <div className="recommendation-dosage">
                  <p className="dosage-text">{rec.dosage || '2000 IU daily'}</p>
                  <p className="timing-text">{rec.timing || 'Morning with food'}</p>
                </div>

                {/* Why This Supplement */}
                {rec.reason && (
                  <div className="recommendation-reason">
                    <div className="reason-header">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a10 10 0 0 1 7.94 16.06L12 22l-7.94-3.94A10 10 0 0 1 12 2z"/>
                        <circle cx="12" cy="11" r="3"/>
                      </svg>
                      <span>Why this supplement?</span>
                    </div>
                    <p className="reason-text">{rec.reason}</p>
                  </div>
                )}

                {/* Key Benefits */}
                {rec.benefits && rec.benefits.length > 0 && (
                  <div className="recommendation-benefits">
                    <h4 className="benefits-title">Key Benefits</h4>
                    <ul className="benefits-list">
                      {rec.benefits.map((benefit, idx) => (
                        <li key={idx}>{benefit}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="recommendation-actions">
                  {isSupplementAdded(rec.name) ? (
                    <button 
                      className="btn-added" 
                      onClick={() => handleAddToPlan(rec)}
                      disabled={addingSupplementId === rec.name}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                      {addingSupplementId === rec.name ? 'Removing...' : 'Added to plan'}
                    </button>
                  ) : (
                    <button 
                      className="btn-add-plan"
                      onClick={() => handleAddToPlan(rec)}
                      disabled={addingSupplementId === rec.name}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M5 12h14"/>
                      </svg>
                      {addingSupplementId === rec.name ? 'Adding...' : 'Add to my plan'}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default RecommendationsPage;
