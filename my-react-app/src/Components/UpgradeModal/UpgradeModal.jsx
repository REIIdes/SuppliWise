import { useEffect, useRef } from 'react';
import { PLAN_LABELS } from '../../utils/plan';
import './UpgradeModal.css';

// Reusable paywall prompt shown when a plan-gated feature is locked.
// Props: feature (display name), requiredPlan (tier key), currentPlan,
//        onClose, onViewPlans.
export default function UpgradeModal({ feature, requiredPlan, currentPlan, onClose, onViewPlans }) {
  const requiredLabel = PLAN_LABELS[requiredPlan] || requiredPlan;
  const currentLabel = currentPlan ? (PLAN_LABELS[currentPlan] || currentPlan) : PLAN_LABELS.free;
  const primaryRef = useRef(null);

  // Escape closes, and the page behind must not scroll under the dialog.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    primaryRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const name = feature || 'This feature';

  return (
    <div className="upgrade-overlay" onClick={onClose}>
      <div
        className="upgrade-box"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-modal-title"
        aria-describedby="upgrade-modal-body"
      >
        <div className="upgrade-hero" aria-hidden="true">
          <span className="upgrade-hero__glow" />
          <span className="upgrade-hero__sheen" />
          <span className="upgrade-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="10.5" width="16" height="10" rx="3" />
              <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
              <circle cx="12" cy="15.4" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span className="upgrade-tier">{requiredLabel || 'Paid plan'}</span>
        </div>

        <div className="upgrade-content">
          <p className="upgrade-eyebrow">Premium feature</p>
          <h3 className="upgrade-title" id="upgrade-modal-title">
            Unlock <span className="upgrade-title__accent">{name}</span>
          </h3>
          <p className="upgrade-body" id="upgrade-modal-body">
            {name} is part of the <strong>{requiredLabel || 'paid'}</strong> plan
            {currentPlan ? <> — you&rsquo;re currently on <strong>{currentLabel}</strong>.</> : '.'}
          </p>
          <p className="upgrade-note">
            <svg className="upgrade-note__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8h.01M11 12h1v4h1" />
            </svg>
            <span>
              Ask an administrator to upgrade your plan and switch it on instantly — no re-login needed.
            </span>
          </p>

          <div className="upgrade-actions">
            <button type="button" className="upgrade-btn upgrade-btn-secondary" onClick={onClose}>
              Maybe later
            </button>
            <button type="button" ref={primaryRef} className="upgrade-btn upgrade-btn-primary" onClick={onViewPlans}>
              View my plan
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
