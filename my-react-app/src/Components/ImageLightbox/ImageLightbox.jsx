import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { setOverlayOpen } from '../../utils/overlayRegistry';
import { dataUrlFileName, dataUrlToObjectUrl, describeDataUrl, revokeObjectUrl } from '../../utils/dataUrl';
import './ImageLightbox.css';

/**
 * Full-size viewer for an inline image.
 *
 * WHY THIS EXISTS
 * ---------------
 * The subscription queue used to offer "Open full size" as a plain link:
 *
 *     <a href={proof.src} target="_blank"><img src={proof.src} /></a>
 *
 * `proof.src` is a `data:image/…;base64,…` URL, because that is how the proof
 * is stored (server/utils/subscriptionRequests.js). Every current browser
 * refuses *top-level navigation* to a `data:` URL, so that link opened a new
 * tab containing nothing at all — no image, no error message, nothing in the
 * console. The preview still worked, because `data:` is perfectly legal in
 * `<img src>`, which is what made it read as "the image is broken" instead of
 * "the link is broken".
 *
 * Rather than fight the restriction, this viewer renders the image in place.
 * Rendering was never the problem, so nothing about the image is re-encoded
 * and no network request is made: the bytes are already in memory.
 *
 * The two actions that genuinely must leave the page — "Open in new tab" and
 * "Download" — are served by a `blob:` object URL, which IS same-origin by
 * construction and so is allowed to do both. See utils/dataUrl.js for why the
 * Blob is built with `atob` rather than `fetch`.
 *
 * ZOOM MODEL
 * ----------
 * `scale` is a multiple of the image's *natural* size, not of the fitted size.
 * 1 means one screen pixel per image pixel, and anything below 1 is "fit to
 * the window", which is the state the viewer opens in. Zooming is done by
 * sizing the <img> in explicit pixels rather than with a CSS transform,
 * because a transform does not grow the scrollable area — the stage would stop
 * scrolling the moment the image grew past it, and the right-hand edge of a
 * long receipt would become unreachable.
 */

const OVERLAY_NAME = 'image-lightbox';

/** Below this the fitted image is "fit to window" and the zoom readout says so. */
const FIT_SCALE = 0;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export default function ImageLightbox({
  src,
  alt = 'Image',
  /** Filename stem for the download, e.g. 'payment-proof'. */
  fileBase = 'image',
  onClose,
}) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [scale, setScale] = useState(FIT_SCALE);
  const [natural, setNatural] = useState(null); // { width, height } once decoded
  const [failed, setFailed] = useState(false);
  const titleId = useId();

  // One Blob for the lifetime of the viewer, not one per render. Building it
  // lazily in useState means the (multi-megabyte) decode happens once, on the
  // first render the viewer actually appears.
  const [objectUrl] = useState(() => dataUrlToObjectUrl(src));

  // Revoking on unmount is NOT enough on its own, and getting this wrong is
  // silent: React runs mount → cleanup → mount, so a StrictMode remount revokes
  // the very URL this component is still rendering, and "New tab" and "Save"
  // both keep pointing at a dead Blob. Nothing throws — the links just do
  // nothing when clicked.
  //
  // The revoke is therefore deferred by a tick, which the remount cancels. It
  // is the same "re-arm rather than only disarm" idea the other panels in this
  // codebase use for their mounted flags. A real unmount is not followed by
  // another mount of the same instance, so the timer runs and the Blob — which
  // otherwise pins its decoded bytes for the life of the document, a couple of
  // megabytes per receipt stepped through — is released.
  const revokeTimer = useRef(null);
  useEffect(() => {
    if (revokeTimer.current !== null) {
      window.clearTimeout(revokeTimer.current);
      revokeTimer.current = null;
    }
    return () => {
      revokeTimer.current = window.setTimeout(() => {
        revokeObjectUrl(objectUrl);
        revokeTimer.current = null;
      }, 0);
    };
  }, [objectUrl]);

  const caption = useMemo(() => describeDataUrl(src), [src]);
  const fileName = useMemo(() => dataUrlFileName({ base: fileBase, src }), [fileBase, src]);
  // Nothing to zoom when there is no picture. Leaving the controls live would
  // let a reviewer click through a toolbar that provably does nothing.
  const canZoom = !failed;

  // Tell the AI assistant's edge tab to get out of the way — see
  // utils/overlayRegistry.js for why it cannot simply be given a higher
  // z-index instead.
  useEffect(() => {
    setOverlayOpen(OVERLAY_NAME, true);
    return () => setOverlayOpen(OVERLAY_NAME, false);
  }, []);

  // Lock the page behind the viewer, and hand focus to the close button so the
  // keyboard starts somewhere sensible and Escape works immediately.
  useEffect(() => {
    // Whatever had focus before the overlay opened — in practice the button
    // that opened it. Restoring it on the way out is what stops a keyboard
    // user from being dropped back at the top of the document every time they
    // close a receipt.
    const restoreFocusTo = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (restoreFocusTo instanceof HTMLElement && document.contains(restoreFocusTo)) {
        restoreFocusTo.focus();
      }
    };
  }, []);

  // Escape closes. Tab is kept inside the dialog so focus cannot wander onto
  // the queue behind the overlay, which would scroll the page out from under
  // a viewer that looks fixed.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // A new image means a new fit, and no error carried over from the last one.
  // This is handled by the parent giving this component a `key` of the image
  // src, so a different image is a fresh mount with fresh state. Resetting it
  // from an effect instead would mean an extra render pass on every swap and a
  // frame where the previous image's zoom level is briefly applied to the new
  // one.

  const zoomIn = useCallback(() => {
    // Stepping up from "fit" should land on a real zoom level, not on
    // (fitted scale + 0.25), which is barely distinguishable from where it was.
    setScale((current) => (current === FIT_SCALE ? 1 : clamp(current + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM)));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((current) => {
      if (current === FIT_SCALE) return FIT_SCALE;
      const next = clamp(current - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
      return next <= MIN_ZOOM ? FIT_SCALE : next;
    });
  }, []);

  const fit = useCallback(() => setScale(FIT_SCALE), []);

  const oneToOne = useCallback(() => setScale(1), []);

  const handleImageLoad = useCallback((event) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    // A zero here means the browser has not actually decoded anything, and it
    // would make every later size calculation collapse to 0px.
    if (naturalWidth > 0 && naturalHeight > 0) setNatural({ width: naturalWidth, height: naturalHeight });
  }, []);

  // Clicking the picture toggles between "fit" and "actual pixels" — the one
  // shortcut a reviewer actually reaches for when squinting at a reference
  // number in a bank transfer receipt.
  const handleStageClick = useCallback(() => {
    setScale((current) => (current === FIT_SCALE ? 1 : FIT_SCALE));
  }, []);

  // At "fit" the CSS caps the image to the stage. Once a scale is chosen, the
  // size is pinned in pixels from the decoded dimensions so the stage can
  // scroll to it.
  const imageStyle = useMemo(() => {
    if (scale === FIT_SCALE || !natural) return undefined;
    return {
      width: `${Math.round(natural.width * scale)}px`,
      height: `${Math.round(natural.height * scale)}px`,
    };
  }, [natural, scale]);

  const zoomLabel = scale === FIT_SCALE || !natural
    ? 'Fit'
    : `${Math.round(scale * 100)}%`;

  return (
    <div
      className="ivl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={dialogRef}
      // Clicking the backdrop closes, but the click must not fire when the
      // release lands on the stage or the toolbar after a drag.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className="ivl__bar">
        <div className="ivl__heading">
          <h2 className="ivl__title" id={titleId}>{alt}</h2>
          <p className="ivl__meta">
            {failed
              ? 'This image could not be displayed'
              : `${caption.ext} · ${caption.kilobytes} KB${natural ? ` · ${natural.width}×${natural.height}` : ''}`}
          </p>
        </div>

        <div className="ivl__tools">
          <div className="ivl__zoom" role="group" aria-label="Zoom">
            <button type="button" className="ivl__tool" onClick={zoomOut} aria-label="Zoom out" disabled={!canZoom || scale === FIT_SCALE}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button type="button" className="ivl__tool ivl__tool--wide" onClick={fit} title="Fit to the window" disabled={!canZoom}>
              {zoomLabel}
            </button>
            <button type="button" className="ivl__tool" onClick={zoomIn} aria-label="Zoom in" disabled={!canZoom}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>

          <button
            type="button"
            className="ivl__tool ivl__tool--wide"
            onClick={oneToOne}
            disabled={!natural}
            title="Show at actual size"
          >
            1:1
          </button>
          {objectUrl ? (
            <>
              <a
                className="ivl__tool ivl__tool--wide"
                href={objectUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this image in a new tab"
              >
                New tab
              </a>
              <a
                className="ivl__tool ivl__tool--wide"
                href={objectUrl}
                download={fileName}
                title={`Save as ${fileName}`}
              >
                Save
              </a>
            </>
          ) : null}

          <button
            type="button"
            className="ivl__tool ivl__tool--close"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className="ivl__stage"
        onClick={handleStageClick}
        title={scale === FIT_SCALE ? 'Click to view at actual size' : 'Click to fit to the window'}
      >
        {failed ? (
          <div className="ivl__broken">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
            <p className="ivl__broken-title">This image could not be displayed</p>
            <p className="ivl__broken-text">
              The receipt is attached but its data is damaged, so there is nothing to draw.
              {objectUrl ? ' Use “Save” to pull the original bytes and check them in another app.' : ''}
            </p>
          </div>
        ) : (
          <img
            className={`ivl__img${scale === FIT_SCALE ? ' ivl__img--fit' : ''}`}
            src={src}
            alt={alt}
            style={imageStyle}
            draggable={false}
            onLoad={handleImageLoad}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
