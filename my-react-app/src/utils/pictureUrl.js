/**
 * Resolve a stored picture reference into something an <img> can load.
 *
 * WHY THIS EXISTS
 * ---------------
 * Profile and banner images used to be stored as inline `data:` base64 strings
 * on the user document. That made one account's document ~3 MB, which the
 * server had to read and rewrite on every sign-in — which is what made the
 * login button unusable — and it also meant a multi-megabyte string was being
 * parked in `localStorage`, whose entire budget is around 5 MB.
 *
 * The bytes now live on disk and the API returns a root-relative path such as
 * `/pictures/abc-profile-def.png` (see server/utils/pictures.js).
 *
 * That path is stored deliberately rather than an absolute URL: the app is
 * reached on `localhost` in dev and on a LAN address such as `192.168.1.42`
 * from a phone, and an absolute URL baked into `localStorage` would point at
 * whichever host happened to sign in first. Keeping the path relative and
 * resolving it against the API origin at render time means a changed host
 * keeps working.
 *
 * `src` and `background-image: url()` accept an absolute URL exactly as
 * happily as a data URL, so this is purely about producing an absolute URL —
 * no component needs to care where the bytes actually live.
 */
// Extension required so `node --test` can load this module; see the note on the
// same specifier in api.js.
import { BASE_URL } from '../api.js';

// The API base is `<origin>/api`; pictures are served from `<origin>/pictures`,
// i.e. one level up from the API surface.
const API_ORIGIN = BASE_URL.replace(/\/api\/?$/, '');

/**
 * @param {*} value a picture reference from the API or from stored user state
 * @returns {string} an absolute URL, or '' when there is no usable picture
 *
 * Passes through anything already loadable (`data:`, `http:`, `https:`) so
 * this is safe to call on a value that has not been migrated, and is a no-op
 * for the many components that were already correct.
 */
export function pictureUrl(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';

  // Already absolute or inline — nothing to resolve.
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;

  // Our stored path. Anything else (a relative path we do not own, a stray
  // scheme such as `javascript:`) is refused rather than passed to the DOM.
  if (raw.startsWith('/pictures/') && !raw.startsWith('//')) {
    return `${API_ORIGIN}${raw}`;
  }

  return '';
}

export default pictureUrl;
