import { useEffect, useId, useRef } from 'react';
import { categoryLabel, fullStamp, timeAgo, visualKind } from '../../notifications/notificationTargets';
import NotificationGlyph from '../../notifications/NotificationGlyph';
import '../../notifications/notificationAccents.css';
import './NotificationDetailModal.css';

/**
 * THE NOTIFICATION DETAIL WINDOW.
 *
 * Pressing a row in either bell used to navigate immediately — and because the
 * destination was guessed from the title, a support reply opened the assessment
 * history. Now a press opens THIS instead: the full message, and three
 * deliberate choices (read it, clear it, go there). Nothing moves under the
 * user until they choose to, and "go there" is only offered when the row
 * actually knows where it goes.
 *
 * Used by BOTH consoles — `kind` is the only thing that differs (word choice,
 * and the fact that an admin row can be non-dismissible).
 *
 * ── Behaviour that is load-bearing ───────────────────────────────────────────
 *
 *  • Escape and the overlay both close it; neither performs an action. Opening
 *    this window must never cost a notification.
 *  • The overlay click closes only if the press STARTED on the overlay. Without
 *    that check, a text selection dragged out of the message and released over
 *    the backdrop would close the window — and take the half-dragged selection
 *    with it.
 *  • Focus moves into the dialog on open and returns to whatever was focused on
 *    close, so a keyboard user is not dropped back at the top of the document.
 *  • The buttons are the only focusable things inside, and Tab is trapped, so
 *    the page behind cannot be tabbed to while the window is up.
 */
function NotificationDetailModal({
  item,
  kind = 'user',
  target = null,
  busy = null,
  canDelete = true,
  error = '',
  onClose,
  onMarkRead,
  onDelete,
  onGoTo,
}) {
  const dialogRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const titleId = useId();
  const bodyId = useId();

  const dismissible = canDelete && !!item?._id;
  // An already-read notice has nothing left to mark, so the button is shown
  // disabled rather than hidden: a row that silently loses a button is how
  // "Mark all as read" looks like it did nothing on one row.
  const canMarkRead = !!item?._id && !!item?.read === false && !busy;

  useEffect(() => {
    if (!item) return undefined;
    restoreFocusRef.current = document.activeElement;
    // Focus the first control rather than the dialog itself: a keyboard user
    // should land on something they can act on.
    const first = dialogRef.current?.querySelector('button:not([disabled])');
    if (first) first.focus();
    return () => {
      const el = restoreFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [item]);

  useEffect(() => {
    if (!item) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      // Focus trap: the page behind stays inert while this is up.
      const focusable = [...(dialogRef.current?.querySelectorAll('button:not([disabled])') || [])];
      if (focusable.length === 0) return;
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
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [item, onClose]);

  if (!item) return null;

  // Only close when the press BEGAN on the backdrop. `mousedown` rather than
  // `click` because by click time a drag has already released over here.
  const onOverlayMouseDown = (event) => {
    if (event.target === event.currentTarget) onClose?.();
  };

  const readLabel = item.read ? 'Read' : 'Unread';
  const category = categoryLabel(item, kind);
  // The window wears the same accent the row wore, so pressing a violet support
  // row opens a violet window. One family, one meaning, across both consoles.
  const family = visualKind(item, kind);

  return (
    <div className="ndm-overlay" onMouseDown={onOverlayMouseDown}>
      <div
        className={`ndm nd-root nd-kind-${family}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={item.detail ? bodyId : undefined}
        ref={dialogRef}
      >
        {/* A coloured band across the top. It carries the family glyph, the
            category and the read state together, so the eye gets the summary
            before it reaches a word of the message. */}
        <header className="ndm__head">
          <span className="ndm__glyph">
            <NotificationGlyph kind={family} />
          </span>
          <span className="ndm__headtext">
            <span className={`ndm__kind${item.read ? '' : ' ndm__kind--unread'}`}>
              {category}
            </span>
            <span className="ndm__when">{fullStamp(item.createdAt)}</span>
          </span>
          <button
            type="button"
            className="ndm__close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <h2 className="ndm__title" id={titleId}>{item.title}</h2>

        {item.detail && (
          <p className="ndm__body" id={bodyId}>{item.detail}</p>
        )}

        <p className="ndm__meta">
          <span className={`nd-state${item.read ? '' : ' nd-state--unread'}`}>{readLabel}</span>
          {item.createdAt && <span className="ndm__ago">{timeAgo(item.createdAt)}</span>}
        </p>

        {error && <p className="ndm__error" role="alert">{error}</p>}

        {/* The redirect row is its own group so "go there" can be the full-width
            primary action — it is the one button most people came here for —
            while read/delete stay a quiet pair beneath it. */}
        <div className="ndm__actions">
          {target && (
            <button
              type="button"
              className="ndm__btn ndm__btn--primary"
              onClick={onGoTo}
              disabled={busy !== null}
            >
              <NotificationGlyph kind={family} />
              {target.label}
            </button>
          )}

          <div className="ndm__actions-row">
            <button
              type="button"
              className="ndm__btn"
              onClick={onMarkRead}
              disabled={!canMarkRead || busy !== null}
              title={item.read ? 'Already read' : 'Mark this notification as read'}
            >
              {busy === 'read' ? 'Marking…' : 'Mark as read'}
            </button>

            {dismissible && (
              <button
                type="button"
                className="ndm__btn ndm__btn--danger"
                onClick={onDelete}
                disabled={busy !== null}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default NotificationDetailModal;