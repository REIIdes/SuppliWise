import { useEffect, useId } from 'react';
import './InstallAppModal.css';

function InstallAppModal({ onClose }) {
  const titleId = useId();
  const noteId = useId();

  /* A device that already runs the app must never see a "scan to install"
     QR — it would duplicate the app. Same standalone-mode signal plus the
     flag App.jsx stamps every time the PWA boots. */
  const isInstalled =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    (() => { try { return localStorage.getItem('suppliwise:pwa-installed') === '1'; } catch { return false; } })();

  // Escape closes — the same rule every other modal in this app follows.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="install-modal-overlay" onClick={onClose}>
      <div
        className="install-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="install-modal-title" id={titleId}>Install SuppliWise</h2>
        {isInstalled ? (
          <>
            <p className="install-modal-subtitle" id={noteId}>
              SuppliWise is already installed on this device — no need to install again.
            </p>
            <button
              type="button"
              className="install-modal-open"
              onClick={() => window.location.assign('/')}
            >
              Open SuppliWise
            </button>
          </>
        ) : (
          <>
            <p className="install-modal-subtitle">
              Scan the QR code with your phone camera to install the SuppliWise mobile app.
            </p>

            {/* PLACEHOLDER — the mobile QR code is under development. When the real
                QR is ready, replace this block with:
                  <img className="install-modal-qr-image" src={QR_URL} alt="QR code to install the SuppliWise app" />
            */}
            <div className="install-modal-qr-placeholder">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <path d="M14 14h3v3h-3z" />
                <path d="M21 14v.01" />
                <path d="M14 21h.01" />
                <path d="M18 18h3v3h-3z" />
              </svg>
              <p className="install-modal-qr-coming">QR code under development</p>
              <p className="install-modal-qr-note" id={noteId}>
                The mobile installer QR is coming soon. You can already install SuppliWise
                from your browser&rsquo;s &ldquo;Add to Home Screen&rdquo; / &ldquo;Install App&rdquo; option.
              </p>
            </div>
          </>
        )}

        <button type="button" className="install-modal-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export default InstallAppModal;
