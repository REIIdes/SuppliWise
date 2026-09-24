import { useEffect, useRef } from 'react';
import './ConfirmLogoutModal.css';

// ═══════════════════════════════════════════════════════════════════════════
// Confirm Logout — the shared sign-out dialog for BOTH the admin panel and
// the user Profile page (this flow gets its own vibrant identity instead of
// the generic grey ConfirmModal used by delete confirmations).
//
// Vibrant amber/orange design: gradient icon badge with a pulse ring,
// layered corner glows, gradient primary button with lift-on-hover.
//   · Esc or overlay-click cancels
//   · focus starts on Cancel, so Enter never wipes a session by accident
//   · body scroll locked while open (previous value restored on unmount)
// ═══════════════════════════════════════════════════════════════════════════
function ConfirmLogoutModal({
  title = 'Confirm Logout',
  message = 'Are you sure you want to log out?',
  confirmText = 'Log Out',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  // Keep the latest onCancel reachable from the one-shot effects below
  // (parents pass inline arrows, so its identity changes every render).
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    cancelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onCancelRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="clo-overlay" onClick={() => onCancelRef.current?.()}>
      <div
        className="clo-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clo-title"
        aria-describedby="clo-message"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Decorative corner glows — pure atmosphere, never interactive */}
        <span className="clo-glow clo-glow--amber" aria-hidden="true" />
        <span className="clo-glow clo-glow--violet" aria-hidden="true" />

        {/* Gradient warning badge with a soft pulse ring */}
        <div className="clo-icon" aria-hidden="true">
          <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13.5" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="clo-icon-ring" />
        </div>

        <h2 className="clo-title" id="clo-title">{title}</h2>
        <p className="clo-message" id="clo-message">{message}</p>

        <div className="clo-actions">
          <button type="button" ref={cancelRef} className="clo-btn clo-btn--cancel" onClick={() => onCancelRef.current?.()}>
            {cancelText}
          </button>
          <button type="button" className="clo-btn clo-btn--confirm" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmLogoutModal;
