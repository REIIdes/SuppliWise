/**
 * ProfileAvatarImage — the one place a profile picture is rendered.
 *
 * WHY THIS IS SHARED
 * The identity card and the account menu both show "the user's picture". They
 * used to each render their own <img>, which let them drift in three ways:
 *
 *   1. Only the identity card had an onError fallback, so a picture that
 *      failed to decode showed the browser's torn-image glyph in the menu
 *      while the card correctly fell back to the initial.
 *   2. The fallback was implemented by mutating the DOM
 *      (`img.style.display = 'none'`). React does not own that inline style,
 *      so it never resets it — choosing a NEW picture after a failed one left
 *      the valid image permanently hidden. That was a real, reachable bug.
 *   3. Two different gradients/rings meant the same avatar looked like two
 *      different things at two sizes.
 *
 * Using a per-source failure record fixes all three at once, with no effect
 * and no reset bookkeeping.
 */
import { useState } from 'react';

/**
 * @param {string}  src        Picture URL/data-URL. Empty string = no picture.
 * @param {string}  name       Used for the initial-letter fallback.
 * @param {string}  className  Class for the <img>. Omitted when falling back.
 * @param {boolean} decorative Hide from assistive tech when the surrounding
 *                             element already labels the avatar.
 */
export default function ProfileAvatarImage({ src, name = '', className = '', decorative = true }) {
  // The failure is recorded AS the source that failed, not as a boolean. That
  // is what makes recovery automatic: a new `src` is by definition not equal
  // to `failedSrc`, so it renders immediately — no effect, no reset, and no
  // way for a stale flag to hide a freshly-chosen picture.
  const [failedSrc, setFailedSrc] = useState(null);

  const initial = (name || 'U').charAt(0).toUpperCase();
  const showImage = Boolean(src) && failedSrc !== src;

  return (
    <>
      {/* Always in the DOM, behind the image: it is the fallback AND the
          backdrop that shows through any transparent PNG. */}
      <span className="pai-initial" aria-hidden="true">{initial}</span>
      {showImage && (
        <img
          className={className}
          src={src}
          alt=""
          aria-hidden={decorative ? 'true' : undefined}
          onError={() => setFailedSrc(src)}
        />
      )}
    </>
  );
}
