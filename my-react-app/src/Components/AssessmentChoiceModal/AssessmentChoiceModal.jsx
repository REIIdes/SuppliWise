import { useEffect, useId } from 'react';
import './AssessmentChoiceModal.css';

/**
 * The choice the dashboard's New Assessment card offers when the user
 * already has an assessment in force: continue from it (answers
 * pre-filled, progress carried over) or start over.
 *
 * A dedicated modal rather than a second ConfirmModal because the
 * decision has THREE outcomes — and the two actions are not a
 * confirm/cancel pair, so neither may hide behind the "Cancel" button
 * that Escape and the overlay click are wired to. Both choices are
 * equally deliberate actions; dismissing must never pick one.
 */
function AssessmentChoiceModal({ assessmentDate, hasUnfinishedSupplements, onUpdate, onStartNew, onCancel }) {
  const titleId = useId();
  const messageId = useId();

  // Escape always dismisses without choosing — the same contract
  // ConfirmModal has, so the two dialogs behave identically.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const date = assessmentDate
    ? new Date(assessmentDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';

  return (
    <div className="confirm-modal-overlay" onClick={onCancel}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-modal-title" id={titleId}>New Assessment</h2>
        <p className="confirm-modal-message" id={messageId}>
          You have an active assessment{date ? ` from ${date}` : ''}. What would you like to do?
          {hasUnfinishedSupplements && ' Either choice replaces your current plan — supplements you have not taken today are replaced.'}
        </p>
        <div className="choice-modal-options">
          <button type="button" className="choice-modal-option choice-modal-option-update" onClick={onUpdate}>
            <span className="choice-modal-option-title">Update current assessment</span>
            <span className="choice-modal-option-desc">Pre-fills your previous answers. Streak, adherence and intake history carry over.</span>
          </button>
          <button type="button" className="choice-modal-option choice-modal-option-new" onClick={onStartNew}>
            <span className="choice-modal-option-title">Start a new assessment</span>
            <span className="choice-modal-option-desc">Fresh answers and a new plan. Tracking starts again from zero.</span>
          </button>
        </div>
        <button type="button" className="choice-modal-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default AssessmentChoiceModal;
