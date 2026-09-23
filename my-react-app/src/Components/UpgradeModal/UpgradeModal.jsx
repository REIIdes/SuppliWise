import { PLAN_LABELS } from '../../utils/plan';
import './UpgradeModal.css';

// Reusable paywall prompt shown when a plan-gated feature is locked.
// Props: feature (display name), requiredPlan (tier key), currentPlan,
//        onClose, onViewPlans.
export default function UpgradeModal({ feature, requiredPlan, currentPlan, onClose, onViewPlans }) {
  const requiredLabel = PLAN_LABELS[requiredPlan] || requiredPlan;
  const currentLabel = currentPlan ? (PLAN_LABELS[currentPlan] || currentPlan) : PLAN_LABELS.free;

  return (
    <div className="upgrade-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Upgrade required">
      <div className="upgrade-box" onClick={(e) => e.stopPropagation()}>
        <div className="upgrade-icon" aria-hidden="true">🔒</div>
        <h3 className="upgrade-title">{feature || 'This feature'} is locked</h3>
        <p className="upgrade-body">
          {feature || 'This feature'} requires {requiredLabel ? <strong>{requiredLabel}</strong> : 'a paid plan'}.
          {currentPlan && (
            <> Your current plan is <strong>{currentLabel}</strong>.</>
          )}
        </p>
        <p className="upgrade-note">Contact an administrator to upgrade your plan and unlock this feature.</p>
        <div className="upgrade-actions">
          <button type="button" className="upgrade-btn upgrade-btn-secondary" onClick={onClose}>
            Maybe later
          </button>
          <button type="button" className="upgrade-btn upgrade-btn-primary" onClick={onViewPlans}>
            View my plan
          </button>
        </div>
      </div>
    </div>
  );
}
