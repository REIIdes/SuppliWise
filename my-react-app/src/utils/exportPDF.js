import { getStoredUser } from '../api';
import { isStaleChunkError, markChunkReloadHealthy, reloadOnceForStaleChunk } from './chunkReload.js';

// jsPDF (+ autotable) is ~350 KB of module code, and this renderer runs only
// when someone actually clicks Export. Statically importing ./wellnessReport
// here put all of it inside the Results, History and Assessment-management
// route chunks, so those routes had to parse a PDF library before their first
// paint. Loading it on demand keeps it out of every route that merely offers
// the button.
let wellnessRendererPromise;

function loadWellnessRenderer() {
  if (!wellnessRendererPromise) {
    wellnessRendererPromise = import('./wellnessReport')
      .then((mod) => {
        // The module loaded, so the page is talking to the current optimizer
        // state again; allow a later failure its own single self-heal.
        markChunkReloadHealthy();
        return mod;
      });
    // A failed chunk load must not poison every later attempt.
    wellnessRendererPromise.catch(() => { wellnessRendererPromise = undefined; });
  }
  return wellnessRendererPromise;
}

/**
 * Export a member wellness report.
 *
 * Keeping this public entry point stable means the live results page, history
 * page, and the admin assessment manager all use the same renderer and the
 * same validation/pagination behaviour.
 */
export async function exportResultsToPDF(recommendations, assessment) {
  let wellness;
  try {
    wellness = await loadWellnessRenderer();
  } catch (loadError) {
    // A stale Vite dep hash is fixed by reloading, not by an error message.
    // Report it as a normal failure if that self-heal was already used.
    if (isStaleChunkError(loadError) && reloadOnceForStaleChunk(loadError)) {
      return null;
    }
    console.error('PDF renderer could not be loaded:', loadError);
    return null;
  }

  try {
    return await wellness.downloadWellnessReport({
      results: recommendations || {},
      assessment: assessment || {},
      userName: assessment?.userName
        || assessment?.name
        || storedUserName()
        || '',
    });
  } catch (error) {
    console.warn('Wellness PDF renderer recovered with the safe fallback:', error);
    try {
      return await wellness.downloadWellnessFallback({
        results: recommendations || {},
        assessment: assessment || {},
        userName: assessment?.userName || assessment?.name || '',
      });
    } catch (fallbackError) {
      console.error('Fallback PDF generation failed:', fallbackError);
      return null;
    }
  }
}

// Storage can be unavailable (private browsing, a webview, a smoke test) — a
// report must still be generatable without it, so this never throws.
function storedUserName() {
  try {
    return (getStoredUser() || {}).name;
  } catch {
    return '';
  }
}
