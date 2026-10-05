/**
 * PlanLockedCard — the full-page "your plan doesn't include this" state.
 *
 * Design intent (it used to be a plain white box with a 🔒 emoji and two flat
 * grey buttons, which read as a dead end rather than an offer):
 *
 *   • State the VALUE first, not the lock. "Upgrade to unlock" is a reason to
 *     keep reading; "is locked" is a wall.
 *   • Show the gap literally — current plan → required plan — so the size of
 *     the ask is obvious at a glance instead of being buried in a sentence.
 *   • List what the upgrade actually buys. A paywall that names its own
 *     benefits is making an argument; one that just refuses is not.
 *   • Exactly one dominant action. Previously two equally-weighted buttons
 *     split attention and neither won.
 *   • Be honest about the upgrade path. This app is admin-provisioned, so we
 *     say so plainly rather than implying a checkout that doesn't exist.
 *
 * Icons are inline SVG rather than an icon package: the app ships react-icons
 * but uses it nowhere, and this keeps the component dependency-free.
 */
import { PLAN_LABELS } from '../../subscription/features';
import './PlanLockedCard.css';

const labelFor = (plan) => PLAN_LABELS[plan] || plan || PLAN_LABELS.free;

function LockBadge() {
  return (
    <div className="plc-badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="38" height="38" fill="none">
        <defs>
          <linearGradient id="plc-lock-fill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0d9488" />
            <stop offset="55%" stopColor="#4f46e5" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        {/* shackle */}
        <path
          d="M7.5 10.5V7.75a4.5 4.5 0 0 1 9 0v2.75"
          stroke="url(#plc-lock-fill)"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        {/* body */}
        <rect x="4.5" y="10.5" width="15" height="10" rx="3" fill="url(#plc-lock-fill)" />
        {/* keyhole */}
        <circle cx="12" cy="14.6" r="1.5" fill="#fff" fillOpacity=".95" />
        <path d="M12 15.7v2.1" stroke="#fff" strokeOpacity=".95" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true" className="plc-check">
      <path
        d="M4.5 10.5l3.4 3.4 7.6-7.8"
        stroke="currentColor"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true" className="plc-arrow">
      <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function PlanLockedCard({
  featureLabel = 'This feature',
  requiresPlan,
  currentPlan,
  benefits = [],
  onViewPlans,
  onBack,
  viewPlansLabel = 'View my plan',
  backLabel = 'Back to Dashboard',
  footnote = 'Plans are provisioned by an administrator. Contact one to upgrade and unlock this feature instantly.',
}) {
  const target = labelFor(requiresPlan);
  const current = labelFor(currentPlan);

  return (
    <section className="plc-card" role="region" aria-labelledby="plc-title">
      <div className="plc-card__aurora" aria-hidden="true" />

      <div className="plc-card__body">
        <LockBadge />

        <p className="plc-eyebrow">
          <span className="plc-eyebrow__dot" aria-hidden="true" />
          {featureLabel}
        </p>

        <h2 className="plc-title" id="plc-title">
          Upgrade to unlock
          <span className="plc-title__accent"> {featureLabel}</span>
        </h2>

        <p className="plc-lede">
          {benefits.length > 0
            ? 'Here’s what your plan is missing — everything below turns on the moment you upgrade.'
            : 'This part of your account needs a higher plan.'}
        </p>

        {/* The gap, shown rather than described. */}
        <div className="plc-journey" aria-label={`Your current plan is ${current}. ${target} is required.`}>
          <div className="plc-journey__end">
            <span className="plc-journey__caption">Your plan</span>
            <span className="plc-pill plc-pill--current">{current}</span>
          </div>

          <span className="plc-journey__arrow" aria-hidden="true">
            <ArrowRight />
          </span>

          <div className="plc-journey__end">
            <span className="plc-journey__caption">Required</span>
            <span className="plc-pill plc-pill--target">
              {target}
              <span className="plc-pill__sparkle" aria-hidden="true" />
            </span>
          </div>
        </div>

        {benefits.length > 0 && (
          <div className="plc-panel">
            <h3 className="plc-panel__title">What you unlock</h3>
            <ul className="plc-benefits">
              {benefits.map((item) => (
                <li className="plc-benefit" key={item}>
                  <CheckIcon />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="plc-actions">
          {onViewPlans && (
            <button type="button" className="plc-btn plc-btn--primary" onClick={onViewPlans}>
              {viewPlansLabel}
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {onBack && (
            <button type="button" className="plc-btn plc-btn--ghost" onClick={onBack}>
              {backLabel}
            </button>
          )}
        </div>

        <p className="plc-footnote">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 11v5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="7.9" r="1.1" fill="currentColor" />
          </svg>
          {footnote}
        </p>
      </div>
    </section>
  );
}
