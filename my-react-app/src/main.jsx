import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './mobile-responsive.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

// ── Dev self-heal: no service worker may run against the dev server ────────
// An earlier build shipped a hand-written worker (public/sw.js) that cached
// app-shell responses under an unpinned name, and devOptions once enabled a
// worker too — either one keeps a long-lived tab rendering a STALE bundle no
// matter how many times the page reloads (old navbar, "my fixes don't show").
// While developing: unregister every worker and drop its caches, so each load
// comes fresh from Vite. Production registration below is untouched.
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
    .then(() => (typeof caches !== 'undefined' ? caches.keys() : []))
    .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
    .catch(() => { /* best-effort cleanup — next load retries */ })
}

// Register the service worker and keep it fresh WITHOUT interrupting the user.
// The old confirm() prompt was both an unwanted UI interruption and a staleness
// bug: dismissing it left the browser running outdated JS indefinitely (fixed
// bugs kept alive in long-lived tabs).
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // Activate the new worker silently — the user is never interrupted, and
    // fresh code loads on the next navigation/reload.
    updateSW(false);
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    // Long-lived tabs re-check periodically so nobody sits on a stale build.
    setInterval(() => { registration.update(); }, 15 * 60 * 1000);
  },
  onOfflineReady() {
    console.log('App ready to work offline')
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
