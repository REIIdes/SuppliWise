import { getStoredUser } from '../api';
import { downloadWellnessFallback, downloadWellnessReport } from './wellnessReport';

/**
 * Export a member wellness report.
 *
 * Keeping this public entry point stable means the live results page, history
 * page, and the admin assessment manager all use the same renderer and the
 * same validation/pagination behaviour.
 */
export async function exportResultsToPDF(recommendations, assessment) {
  try {
    let storedUser = {};
    try {
      storedUser = getStoredUser() || {};
    } catch {
      // A report can still be generated when storage is unavailable (private
      // browsing, a webview, or a server-side smoke test).
      storedUser = {};
    }

    return await downloadWellnessReport({
      results: recommendations || {},
      assessment: assessment || {},
      userName: assessment?.userName
        || assessment?.name
        || storedUser.name
        || '',
    });
  } catch (error) {
    console.warn('Wellness PDF renderer recovered with the safe fallback:', error);
    try {
      return await downloadWellnessFallback({
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
