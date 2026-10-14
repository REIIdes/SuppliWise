import { useEffect, useId, useState } from 'react';
import './MedicalAttentionModal.css';

function MedicalAttentionModal({
  symptoms = [],
  onClose,
  onConfirmApproval,
  isConfirming = false,
}) {
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="medical-modal-overlay"
      onClick={onClose}
    >
      <div
        className="medical-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Corner glows */}
        <div className="med-glow med-glow--primary" aria-hidden="true" />
        <div className="med-glow med-glow--secondary" aria-hidden="true" />

        {/* Badge icon with pulse ring */}
        <div className="medical-modal-icon" aria-hidden="true">
          <div className="medical-modal-icon-ring" />
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>

        <h2 className="medical-modal-title" id={titleId}>
          Health Safety Alert
        </h2>
        
        <p className="medical-modal-message" id={messageId}>
          Your health assessment has identified symptoms that may require further attention. To help ensure safe supplement guidance, creating or updating health assessments is temporarily unavailable.
        </p>

        {symptoms.length > 0 && (
          <div className="emergency-guidance emergency-guidance--static expanded">
            <div className="emergency-guidance-header-static">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>Symptoms Detected</span>
            </div>
            <div className="emergency-guidance-content">
              <ul className="emergency-list">
                {symptoms.map((symptom, idx) => (
                  <li key={idx}>{symptom}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {currentStatus === 'none' && (
          <>
            <div className="medical-modal-section">
              <h3>What should you do?</h3>
              <p>
                Our system provides dietary supplement guidance based on the information you provide. 
                It does not diagnose, treat, or manage medical conditions.
              </p>
              <p>
                If you are experiencing severe or concerning symptoms, please consult a qualified healthcare professional. 
                For a medical emergency, contact local emergency services.
              </p>
            </div>

            <div className="medical-modal-disclaimer">
              <p>
                <strong>Important:</strong> This system does not diagnose medical conditions or replace professional medical advice.
              </p>
            </div>
          </>
        )}

        {/* Admin Response Section - only shown when approved and user clicks button */}
        {currentStatus === 'approved' && showAdminResponse && adminNotes && (
          <div className="admin-response-section">
            <h3>Administrator's Response</h3>
            <div className="admin-notes-box">
              <p>{adminNotes}</p>
            </div>
          </div>
        )}

        <div className="medical-modal-actions">
          {currentStatus === 'none' && (
            <button
              type="button"
              className="medical-modal-btn medical-modal-btn-request"
              onClick={onConfirmApproval}
              disabled={isConfirming}
            >
              {isConfirming ? 'Processing...' : 'I Understand'}
            </button>
          )}
          <button
            type="button"
            className="medical-modal-btn medical-modal-btn-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default MedicalAttentionModal;
