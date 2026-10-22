import './BackendStatusBanner.css';
import { useBackendOffline } from '../../hooks/useBackendStatus.js';

/* Global "backend is down" notice.

   Rendered once, above the router, so it appears on every page — including
   pages whose own error state is just a card in the middle of the content.
   The frontend stays fully visible by design; this bar is what tells the
   user WHY the action buttons are disabled. */
function BackendStatusBanner() {
  const offline = useBackendOffline();
  if (!offline) return null;

  return (
    <div className="backend-offline-banner" role="alert">
      <span className="backend-offline-banner__dot" aria-hidden="true" />
      <span>
        Cannot reach the server. The app is view-only — actions resume
        automatically once the backend is back online.
      </span>
    </div>
  );
}

export default BackendStatusBanner;
