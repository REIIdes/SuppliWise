import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import Toast from '../Components/Toast/Toast';
import { getHistory, addSupplementToPlan, removeSupplementFromPlan, getMyPlan } from '../api';
import './RecommendationsPage.css';

function RecommendationsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [recommendations, setRecommendations] = useState(null);
  const [activeTab, setActiveTab] = useState('all');
  const [error, setError] = useState('');
  const [addedSupplements, setAddedSupplements] = useState(new Set());
  const [addingSupplementId, setAddingSupplementId] = useState(null);
  const [toast, setToast] = useState('');
  const [toastKey, setToastKey] = useState(0);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }

    fetchLatestRecommendations();
    fetchMyPlan();
    
    // Cleanup timer on unmount
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, [navigate]);

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
      setLoading(true);
      const historyData = await getHistory(1, 1);
      
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
    } finally {
      setLoading(false);
    }
  };

  const getFilteredRecommendations = () => {
    if (!recommendations) return [];
    
    // Sort by: added status (not added first, added last), then priority (High → Medium → Low), then confidence score
    const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
    const sorted = [...recommendations].sort((a, b) => {
      const aName = a.name || a.supplement;
      const bName = b.name || b.supplement;
      const aAdded = addedSupplements.has(aName);
      const bAdded = addedSupplements.has(bName);
      
      // First: added status (not added first, added last)
      if (aAdded !== bAdded) return aAdded ? 1 : -1;
      
      // Then: priority (High → Medium → Low)
      const pa = PRIORITY_ORDER[a.priority] ?? 3;
      const pb = PRIORITY_ORDER[b.priority] ?? 3;
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

  const getPriorityBadgeClass = (priority) => {
    switch (priority?.toLowerCase()) {
      case 'high': return 'priority-badge-high';
      case 'medium': return 'priority-badge-medium';
      case 'low': return 'priority-badge-low';
      default: return 'priority-badge-medium';
    }
  };

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
        <div className="recommendations-loading">
          <div className="loading-spinner"></div>
          <p>Loading your recommendations...</p>
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
            <div style={{ 
              maxWidth: '600px', 
              margin: '40px auto',
              background: 'white',
              borderRadius: '16px',
              border: '1px solid #e5e7eb',
              boxShadow: '0 4px 6px rgba(0, 0, 0, 0.05)',
              padding: '60px 40px'
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ 
                  width: '120px', 
                  height: '120px', 
                  margin: '0 auto 32px', 
                  background: 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)', 
                  borderRadius: '50%', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  boxShadow: '0 10px 25px rgba(16, 185, 129, 0.15)'
                }}>
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                    <line x1="9" y1="11" x2="15" y2="11"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                </div>
                <p style={{ color: '#6b7280', fontSize: '16px', lineHeight: '1.6', marginBottom: '0', maxWidth: '500px', margin: '0 auto' }}>
                  Complete a health assessment to receive personalized AI-powered supplement recommendations tailored to your needs.
                </p>
              </div>
            </div>
          ) : filteredRecommendations.length === 0 ? (
            <div style={{ 
              maxWidth: '600px', 
              margin: '40px auto',
              background: 'white',
              borderRadius: '16px',
              border: '1px solid #e5e7eb',
              boxShadow: '0 4px 6px rgba(0, 0, 0, 0.05)',
              padding: '60px 40px'
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ 
                  width: '120px', 
                  height: '120px', 
                  margin: '0 auto 32px', 
                  background: 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)', 
                  borderRadius: '50%', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  boxShadow: '0 10px 25px rgba(16, 185, 129, 0.15)'
                }}>
                  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
                    <line x1="9" y1="11" x2="15" y2="11"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                </div>
                <p style={{ color: '#6b7280', fontSize: '16px', lineHeight: '1.6', marginBottom: '0', maxWidth: '500px', margin: '0 auto' }}>
                  Complete a health assessment to receive personalized AI-powered supplement recommendations tailored to your needs.
                </p>
              </div>
            </div>
          ) : (
            filteredRecommendations.map((rec, index) => (
              <div key={index} className="recommendation-card">
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
